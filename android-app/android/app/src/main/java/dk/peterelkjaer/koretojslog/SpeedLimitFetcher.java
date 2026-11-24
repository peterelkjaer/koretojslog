package dk.peterelkjaer.koretojslog;

import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Henter hastighedsgrænsen for vejen, man kører på, fra OpenStreetMap (Overpass API).
 * Spørger højst hvert 10. sekund og kun når man har flyttet sig mindst 100 m.
 * Grænsen vises kun, hvis den er under 60 sekunder gammel.
 */
public class SpeedLimitFetcher {
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private volatile boolean busy = false;
    private Location lastQuery;
    private long lastQueryTime = 0;
    private volatile int limit = -1;
    private volatile long limitTime = 0;
    private volatile long wayId = -1;

    int current() { return System.currentTimeMillis() - limitTime < 60_000 ? limit : -1; }

    void onLocation(Location l) {
        long now = System.currentTimeMillis();
        if (busy || now - lastQueryTime < 10_000) return;
        if (lastQuery != null && lastQuery.distanceTo(l) < 100 && now - limitTime < 60_000) return;
        busy = true; lastQuery = l; lastQueryTime = now;
        final double lat = l.getLatitude(), lon = l.getLongitude();
        exec.execute(() -> {
            try { query(lat, lon); } catch (Exception ignored) { } finally { busy = false; }
        });
    }

    private void query(double lat, double lon) throws Exception {
        String q = String.format(Locale.ROOT,
            "[out:json][timeout:6];way(around:20,%.6f,%.6f)[highway][maxspeed];out tags;", lat, lon);
        HttpURLConnection con = (HttpURLConnection) new URL("https://overpass-api.de/api/interpreter").openConnection();
        con.setConnectTimeout(6000); con.setReadTimeout(8000);
        con.setRequestMethod("POST"); con.setDoOutput(true);
        con.setRequestProperty("User-Agent", "Koretojslog/1.8 (personlig app)");
        con.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream out = con.getOutputStream()) { out.write(("data=" + URLEncoder.encode(q, "UTF-8")).getBytes(StandardCharsets.UTF_8)); }
        if (con.getResponseCode() != 200) return;
        String body;
        try (InputStream in = con.getInputStream(); ByteArrayOutputStream b = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            body = b.toString("UTF-8");
        }
        JSONArray els = new JSONObject(body).optJSONArray("elements");
        if (els == null || els.length() == 0) { limit = -1; limitTime = System.currentTimeMillis(); return; }
        int best = -1; long bestId = -1;
        for (int i = 0; i < els.length(); i++) {
            JSONObject e = els.getJSONObject(i);
            int v = parse(e.optJSONObject("tags") != null ? e.getJSONObject("tags").optString("maxspeed") : "");
            if (v <= 0) continue;
            long id = e.optLong("id");
            if (id == wayId) { best = v; bestId = id; break; }   // bliv på samme vej, hvis den stadig er med
            if (best < 0) { best = v; bestId = id; }
        }
        limit = best; wayId = bestId; limitTime = System.currentTimeMillis();
    }

    static int parse(String s) {
        if (s == null) return -1;
        s = s.trim();
        switch (s) {
            case "DK:urban": return 50;
            case "DK:rural": return 80;
            case "DK:motorway": return 130;
            case "DK:trunk": return 80;
            default: break;
        }
        try {
            String num = s.split("[ ;]")[0];
            int v = Integer.parseInt(num);
            if (s.contains("mph")) v = (int) Math.round(v * 1.609);
            return v;
        } catch (Exception e) { return -1; }
    }

    void shutdown() { exec.shutdownNow(); }
}
