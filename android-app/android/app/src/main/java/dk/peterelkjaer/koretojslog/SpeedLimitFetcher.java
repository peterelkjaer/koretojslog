package dk.peterelkjaer.koretojslog;

import android.content.Context;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hastighedsgrænser fra OpenStreetMap.
 * Henter alle veje med en registreret grænse inden for 1 km i ét opslag (med vejenes forløb)
 * og finder derefter selv – uden net – den vej, man kører på. Nyt opslag efter ca. 600 m.
 * Flere Overpass-servere prøves efter tur; hvert opslag skrives i hændelsesloggen.
 */
public class SpeedLimitFetcher {
    private static final String[] SERVERS = {
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter"
    };
    private static final double RADIUS = 1000, REFETCH = 600, MATCH = 25;

    static class Way { long id; int limit; double[] lat, lon; }

    private final Context ctx;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private volatile boolean busy = false;
    private volatile List<Way> ways = null;
    private volatile double cLat, cLon;
    private volatile long fetchTime = 0;
    private long lastAttempt = 0;
    private int serverIdx = 0;
    private int limit = -1;
    private long limitTime = 0;
    private long wayId = -1;

    SpeedLimitFetcher(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    /** Grænsen for vejen lige nu, eller -1 hvis ukendt. */
    int current() { return System.currentTimeMillis() - limitTime < 15_000 ? limit : -1; }

    void onLocation(Location l) {
        long now = System.currentTimeMillis();
        List<Way> w = ways;
        boolean far = w == null || dist(cLat, cLon, l.getLatitude(), l.getLongitude()) > REFETCH || now - fetchTime > 15 * 60_000;
        if (far && !busy && now - lastAttempt > 15_000) {
            busy = true; lastAttempt = now;
            final double lat = l.getLatitude(), lon = l.getLongitude();
            exec.execute(() -> { try { fetch(lat, lon); } finally { busy = false; } });
        }
        if (w != null) match(w, l.getLatitude(), l.getLongitude());
    }

    private void match(List<Way> w, double lat, double lon) {
        double best = Double.MAX_VALUE, prevD = Double.MAX_VALUE; Way bw = null, prev = null;
        for (Way x : w) {
            double d = distToWay(x, lat, lon);
            if (d < best) { best = d; bw = x; }
            if (x.id == wayId) { prevD = d; prev = x; }
        }
        // Bliv på samme vej i kryds og ved parallelle veje, så længe den stadig er tæt på
        if (prev != null && prevD <= MATCH && prevD < best + 6) { bw = prev; best = prevD; }
        if (bw != null && best <= MATCH) { limit = bw.limit; wayId = bw.id; limitTime = System.currentTimeMillis(); }
    }

    private void fetch(double lat, double lon) {
        String q = String.format(Locale.ROOT,
            "[out:json][timeout:25];way(around:%d,%.6f,%.6f)[highway][maxspeed];out tags geom;", (int) RADIUS, lat, lon);
        String lastErr = "";
        for (int attempt = 0; attempt < SERVERS.length; attempt++) {
            String server = SERVERS[(serverIdx + attempt) % SERVERS.length];
            try {
                String body = post(server, q);
                List<Way> list = parse(body);
                ways = list; cLat = lat; cLon = lon; fetchTime = System.currentTimeMillis();
                serverIdx = (serverIdx + attempt) % SERVERS.length;
                TripStore.logEvent(ctx, "Hastighedsgrænser: " + list.size() + " veje hentet (" + new URL(server).getHost() + ")");
                return;
            } catch (Exception e) {
                lastErr = server.replaceFirst("https://", "").split("/")[0] + ": " + e.getClass().getSimpleName() + " " + (e.getMessage() == null ? "" : e.getMessage());
            }
        }
        TripStore.logEvent(ctx, "Hastighedsgrænser kunne ikke hentes – " + lastErr);
    }

    private static String post(String server, String q) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(server).openConnection();
        con.setConnectTimeout(10_000); con.setReadTimeout(30_000);
        con.setRequestMethod("POST"); con.setDoOutput(true);
        con.setRequestProperty("User-Agent", "Koretojslog/1.8 (privat app; github.com/peterelkjaer/koretojslog)");
        con.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        con.setRequestProperty("Accept", "application/json");
        try (OutputStream out = con.getOutputStream()) { out.write(("data=" + URLEncoder.encode(q, "UTF-8")).getBytes(StandardCharsets.UTF_8)); }
        int code = con.getResponseCode();
        if (code != 200) throw new Exception("HTTP " + code);
        try (InputStream in = con.getInputStream(); ByteArrayOutputStream b = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        }
    }

    static List<Way> parse(String body) throws Exception {
        JSONObject root = new JSONObject(body);
        JSONArray els = root.optJSONArray("elements");
        List<Way> out = new ArrayList<>();
        if (els == null) {
            String rem = root.optString("remark", "");
            if (!rem.isEmpty()) throw new Exception(rem);
            return out;
        }
        for (int i = 0; i < els.length(); i++) {
            JSONObject e = els.getJSONObject(i);
            JSONObject tags = e.optJSONObject("tags");
            JSONArray geom = e.optJSONArray("geometry");
            if (tags == null || geom == null || geom.length() < 2) continue;
            int v = parseLimit(tags.optString("maxspeed"));
            if (v <= 0) continue;
            Way w = new Way(); w.id = e.optLong("id"); w.limit = v;
            w.lat = new double[geom.length()]; w.lon = new double[geom.length()];
            for (int k = 0; k < geom.length(); k++) { JSONObject p = geom.getJSONObject(k); w.lat[k] = p.getDouble("lat"); w.lon[k] = p.getDouble("lon"); }
            out.add(w);
        }
        return out;
    }

    static int parseLimit(String s) {
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

    /** Afstand i meter fra et punkt til en vej (nærmeste linjestykke). */
    static double distToWay(Way w, double lat, double lon) {
        double kx = Math.cos(Math.toRadians(lat)) * 111_320, ky = 110_540, best = Double.MAX_VALUE;
        for (int i = 0; i + 1 < w.lat.length; i++) {
            double ax = (w.lon[i] - lon) * kx, ay = (w.lat[i] - lat) * ky;
            double bx = (w.lon[i + 1] - lon) * kx, by = (w.lat[i + 1] - lat) * ky;
            double dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
            double t = len == 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
            double px = ax + t * dx, py = ay + t * dy;
            best = Math.min(best, Math.sqrt(px * px + py * py));
        }
        return best;
    }

    static double dist(double lat1, double lon1, double lat2, double lon2) {
        double kx = Math.cos(Math.toRadians(lat1)) * 111_320, ky = 110_540;
        double dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * ky;
        return Math.sqrt(dx * dx + dy * dy);
    }

    void shutdown() { exec.shutdownNow(); }
}
