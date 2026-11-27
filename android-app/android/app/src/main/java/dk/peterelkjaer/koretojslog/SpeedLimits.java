package dk.peterelkjaer.koretojslog;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dk.peterelkjaer.koretojslog.SpeedLimitMath.Way;

/**
 * Hastighedsgrænser fra OpenStreetMap, gemt på telefonen i felter på ca. 2,2 × 2,2 km.
 *
 * - Alle bilveje hentes (også dem uden registreret grænse – de får en anslået generel grænse).
 * - Felter gemmes på disken i 14 dage, så kendte strækninger virker med det samme og uden net.
 * - Der hentes i forvejen i kørselsretningen, og allerede når turen starter via Bluetooth.
 * - Vejen findes ud fra afstand OG kørselsretning, så sideveje og krydsende veje ikke forveksles.
 * - Der kigges 300 m frem ad vejen for at varsle en kommende ændring af grænsen.
 */
public class SpeedLimits {
    static final double TLAT = 0.02, TLON = 0.035;
    static final long MAX_AGE = 14L * 24 * 3600_000;
    static final double MATCH = 30, AHEAD = 300;
    private static final String HW = "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road)$";
    private static final String[] SERVERS = {
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter"
    };

    /** Hvad skærmen skal vise. */
    static class Result {
        int limit = -1; boolean est = false;   // aktuel grænse (est = anslået generel grænse)
        int ahead = -1; double aheadDist = 0;  // kommende grænse inden for 300 m
        long aheadKey = 0;
    }

    private static SpeedLimits inst;
    static synchronized SpeedLimits get(Context c) {
        if (inst == null) inst = new SpeedLimits(c.getApplicationContext());
        return inst;
    }

    private final Context ctx;
    private final File dir;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final Map<String, List<Way>> mem = new LinkedHashMap<String, List<Way>>(32, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, List<Way>> e) { return size() > 36; }
    };
    private final Map<String, Long> memTime = new ConcurrentHashMap<>();
    private final Set<String> pending = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> retryAt = new ConcurrentHashMap<>();
    private volatile int memVersion = 0;
    private int serverIdx = 0;
    private volatile long backoffUntil = 0;

    // Tilstand for vejvalg (bruges fra hovedtråden)
    private Way cur; private int curDir = 1; private long curTime = 0;
    private double lastLat = Double.NaN, lastLon = Double.NaN; private float bearing = -1;
    private long lastFixTime = 0;
    private List<Way> cand = new ArrayList<>();
    private Map<Long, List<int[]>> nodeIdx = new HashMap<>();
    private String candSig = "";
    private final Result res = new Result();
    private long resTime = 0;

    private SpeedLimits(Context c) {
        ctx = c;
        dir = new File(c.getFilesDir(), "speedtiles");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    // ------------------------------------------------------------------ felter

    static String key(int ty, int tx) { return ty + "_" + tx; }
    static int ty(double lat) { return (int) Math.floor(lat / TLAT); }
    static int tx(double lon) { return (int) Math.floor(lon / TLON); }

    /** Sørger for at feltet under positionen, felterne forude og nære nabofelter er indlæst. */
    void prefetch(double lat, double lon, float brg) {
        List<String> want = new ArrayList<>();
        want.add(key(ty(lat), tx(lon)));
        if (brg >= 0) {
            for (double d : new double[]{700, 1500, 2300}) {
                double[] p = move(lat, lon, brg, d);
                want.add(key(ty(p[0]), tx(p[1])));
            }
        }
        // Nabofelter, når man er mindre end 600 m fra kanten
        double fy = lat / TLAT - ty(lat), fx = lon / TLON - tx(lon);
        double my = 600 / 111_000.0 / TLAT, mx = 600 / (111_000.0 * Math.cos(Math.toRadians(lat))) / TLON;
        int dy = fy < my ? -1 : fy > 1 - my ? 1 : 0, dx = fx < mx ? -1 : fx > 1 - mx ? 1 : 0;
        if (dy != 0) want.add(key(ty(lat) + dy, tx(lon)));
        if (dx != 0) want.add(key(ty(lat), tx(lon) + dx));
        if (dy != 0 && dx != 0) want.add(key(ty(lat) + dy, tx(lon) + dx));

        long now = System.currentTimeMillis();
        for (String k : want) {
            Long t = memTime.get(k);
            boolean inMem; synchronized (mem) { inMem = mem.containsKey(k); }
            if (inMem && t != null && now - t < MAX_AGE) continue;
            Long r = retryAt.get(k);
            if (r != null && now < r) continue;
            if (!pending.add(k)) continue;
            exec.execute(() -> { try { ensure(k); } finally { pending.remove(k); } });
        }
    }

    private void ensure(String k) {
        File f = new File(dir, k + ".json");
        long now = System.currentTimeMillis();
        boolean haveDisk = f.exists();
        if (haveDisk) {
            try {
                List<Way> w = decode(readFile(f));
                put(k, w, f.lastModified());
                if (now - f.lastModified() < MAX_AGE) return;
            } catch (Exception e) { haveDisk = false; }
        }
        if (now < backoffUntil) { retryAt.put(k, backoffUntil); return; }
        String[] p = k.split("_");
        int ty = Integer.parseInt(p[0]), tx = Integer.parseInt(p[1]);
        String q = String.format(Locale.ROOT, "[out:json][timeout:25];way(%.4f,%.4f,%.4f,%.4f)[highway~\"%s\"];out tags geom;",
            ty * TLAT, tx * TLON, (ty + 1) * TLAT, (tx + 1) * TLON, HW);
        String lastErr = "";
        for (int a = 0; a < SERVERS.length; a++) {
            String server = SERVERS[(serverIdx + a) % SERVERS.length];
            try {
                long t0 = System.currentTimeMillis();
                List<Way> w = parse(post(server, q));
                writeFile(f, encode(w));
                put(k, w, System.currentTimeMillis());
                serverIdx = (serverIdx + a + 1) % SERVERS.length;   // fordel belastningen
                retryAt.remove(k);
                TripStore.logEvent(ctx, "Fartgrænser: felt " + k + " – " + w.size() + " veje (" + new URL(server).getHost() + ", " + (System.currentTimeMillis() - t0) / 100 / 10.0 + " s)");
                trimDisk();
                return;
            } catch (Exception e) {
                lastErr = new StringBuilder().append(server.replaceFirst("https://", "").split("/")[0]).append(": ")
                    .append(e.getClass().getSimpleName()).append(' ').append(e.getMessage() == null ? "" : e.getMessage()).toString();
            }
        }
        backoffUntil = System.currentTimeMillis() + 20_000;
        retryAt.put(k, System.currentTimeMillis() + 30_000);
        TripStore.logEvent(ctx, "Fartgrænser: felt " + k + " kunne ikke hentes" + (haveDisk ? " (bruger gemt udgave)" : "") + " – " + lastErr);
    }

    private void put(String k, List<Way> w, long time) {
        synchronized (mem) { mem.put(k, w); }
        memTime.put(k, time);
        memVersion++;
    }

    private void trimDisk() {
        File[] fs = dir.listFiles();
        if (fs == null || fs.length <= 1500) return;
        Arrays.sort(fs, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < fs.length - 1200; i++) //noinspection ResultOfMethodCallIgnored
            fs[i].delete();
    }

    /** Antal gemte felter og samlet størrelse i bytes. */
    long[] diskInfo() {
        File[] fs = dir.listFiles(); long n = 0, b = 0;
        if (fs != null) for (File f : fs) { n++; b += f.length(); }
        return new long[]{n, b};
    }

    void clearDisk() {
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) //noinspection ResultOfMethodCallIgnored
            f.delete();
        synchronized (mem) { mem.clear(); }
        memTime.clear(); memVersion++;
    }

    // ------------------------------------------------------------------ vejvalg

    /** Kaldes med hver GPS-position fra køreskærmen. */
    void onLocation(Location l) {
        double lat = l.getLatitude(), lon = l.getLongitude();
        if (l.hasBearing() && l.hasSpeed() && l.getSpeed() > 2) bearing = l.getBearing();
        else if (!Double.isNaN(lastLat) && SpeedLimitMath.dist(lastLat, lastLon, lat, lon) > 10) bearing = (float) SpeedLimitMath.bearing(lastLat, lastLon, lat, lon);
        if (Double.isNaN(lastLat) || SpeedLimitMath.dist(lastLat, lastLon, lat, lon) > 10) { lastLat = lat; lastLon = lon; }
        lastFixTime = System.currentTimeMillis();
        prefetch(lat, lon, bearing);
        refreshCandidates(lat, lon);
        match(lat, lon);
    }

    /** Kun forudhentning (bruges af turlogningen, før køreskærmen åbnes). */
    void onTripLocation(Location l) {
        float b = l.hasBearing() && l.hasSpeed() && l.getSpeed() > 2 ? l.getBearing() : -1;
        prefetch(l.getLatitude(), l.getLongitude(), b);
    }

    private void refreshCandidates(double lat, double lon) {
        int y = ty(lat), x = tx(lon);
        StringBuilder sig = new StringBuilder().append(y).append(',').append(x).append(',').append(memVersion);
        if (sig.toString().equals(candSig)) return;
        List<Way> all = new ArrayList<>(); Set<Long> seen = new HashSet<>();
        synchronized (mem) {
            for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                List<Way> w = mem.get(key(y + dy, x + dx));
                if (w != null) for (Way a : w) if (seen.add(a.id)) all.add(a);
            }
        }
        cand = all;
        nodeIdx = SpeedLimitMath.buildIndex(all);
        candSig = sig.toString();
    }

    private void match(double lat, double lon) {
        SpeedLimitMath.Hit hit = SpeedLimitMath.bestWay(cand, lat, lon, bearing, cur, curDir, MATCH);
        long now = System.currentTimeMillis();
        if (hit != null) {
            cur = hit.way; curDir = hit.dir; curTime = now;
            res.limit = cur.lim(curDir); res.est = cur.est;
            SpeedLimitMath.Ahead a = SpeedLimitMath.lookAhead(cand, nodeIdx, hit, lat, lon, AHEAD);
            if (a != null && a.limit != res.limit) { res.ahead = a.limit; res.aheadDist = a.dist; res.aheadKey = a.way.id * 1000 + a.limit; }
            else { res.ahead = -1; res.aheadKey = 0; }
            resTime = now;
        } else if (now - curTime > 8000) {
            cur = null; res.limit = -1; res.ahead = -1; res.aheadKey = 0;
        }
    }

    /** Det seneste resultat (tomt, hvis der ikke har været en vej i 10 sek.). */
    Result current() {
        Result r = new Result();
        if (System.currentTimeMillis() - resTime < 10_000) {
            r.limit = res.limit; r.est = res.est; r.ahead = res.ahead; r.aheadDist = res.aheadDist; r.aheadKey = res.aheadKey;
        }
        return r;
    }

    // ------------------------------------------------------------------ data

    static double[] move(double lat, double lon, double brgDeg, double m) {
        double b = Math.toRadians(brgDeg);
        return new double[]{lat + Math.cos(b) * m / 110_540, lon + Math.sin(b) * m / (111_320 * Math.cos(Math.toRadians(lat)))};
    }

    private static String post(String server, String q) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(server).openConnection();
        con.setConnectTimeout(10_000); con.setReadTimeout(35_000);
        con.setRequestMethod("POST"); con.setDoOutput(true);
        con.setRequestProperty("User-Agent", "Koretojslog/1.9 (privat app; github.com/peterelkjaer/koretojslog)");
        con.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        con.setRequestProperty("Accept", "application/json");
        try (OutputStream out = con.getOutputStream()) { out.write(("data=" + URLEncoder.encode(q, "UTF-8")).getBytes(StandardCharsets.UTF_8)); }
        int code = con.getResponseCode();
        if (code != 200) throw new Exception("HTTP " + code);
        try (InputStream in = con.getInputStream()) { return readAll(in); }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[16384]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }
    private static String readFile(File f) throws Exception { try (InputStream in = new FileInputStream(f)) { return readAll(in); } }
    private static void writeFile(File f, String s) throws Exception {
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
        if (!tmp.renameTo(f)) throw new Exception("Kunne ikke gemme felt");
    }

    /** Overpass-svar → veje. */
    static List<Way> parse(String body) throws Exception {
        JSONObject root = new JSONObject(body);
        JSONArray els = root.optJSONArray("elements");
        List<Way> out = new ArrayList<>();
        if (els == null) {
            String rem = root.optString("remark", "");
            throw new Exception(rem.isEmpty() ? "tomt svar" : rem);
        }
        String rem = root.optString("remark", "");
        if (els.length() == 0 && rem.contains("runtime")) throw new Exception(rem);
        for (int i = 0; i < els.length(); i++) {
            JSONObject e = els.getJSONObject(i);
            JSONObject t = e.optJSONObject("tags");
            JSONArray g = e.optJSONArray("geometry");
            if (t == null || g == null || g.length() < 2) continue;
            Way w = new Way(); w.id = e.optLong("id");
            String hw = t.optString("highway");
            int lim = parseLimit(t.optString("maxspeed", null));
            if (lim <= 0) lim = parseLimit(t.optString("maxspeed:type", null));
            if (lim <= 0) lim = parseLimit(t.optString("source:maxspeed", null));
            if (lim <= 0) lim = parseLimit(t.optString("zone:maxspeed", null));
            int f = parseLimit(t.optString("maxspeed:forward", null)), b = parseLimit(t.optString("maxspeed:backward", null));
            if (lim <= 0 && f <= 0 && b <= 0) { lim = estimate(hw); w.est = true; }
            w.limF = f > 0 ? f : lim > 0 ? lim : b;
            w.limB = b > 0 ? b : lim > 0 ? lim : f;
            String ow = t.optString("oneway", "");
            w.oneway = "yes".equals(ow) || "1".equals(ow) || "roundabout".equals(t.optString("junction")) || hw.startsWith("motorway");
            if ("-1".equals(ow)) { // ensrettet mod tegneretningen: vend vejen
                w.oneway = true; int tmp = w.limF; w.limF = w.limB; w.limB = tmp;
                w.lat = new double[g.length()]; w.lon = new double[g.length()];
                for (int k = 0; k < g.length(); k++) { JSONObject p = g.getJSONObject(g.length() - 1 - k); w.lat[k] = r6(p.getDouble("lat")); w.lon[k] = r6(p.getDouble("lon")); }
            } else {
                w.lat = new double[g.length()]; w.lon = new double[g.length()];
                for (int k = 0; k < g.length(); k++) { JSONObject p = g.getJSONObject(k); w.lat[k] = r6(p.getDouble("lat")); w.lon[k] = r6(p.getDouble("lon")); }
            }
            out.add(w);
        }
        return out;
    }

    static double r6(double v) { return Math.round(v * 1e6) / 1e6; }

    /** Generel grænse efter vejtype (Danmark), når OSM ikke har en grænse. */
    static int estimate(String hw) {
        switch (hw == null ? "" : hw) {
            case "motorway": return 130;
            case "residential": return 50;
            case "living_street": return 15;
            default: return 80;
        }
    }

    static int parseLimit(String s) {
        if (s == null) return -1;
        s = s.trim();
        switch (s) {
            case "DK:urban": case "DK:zone50": return 50;
            case "DK:rural": return 80;
            case "DK:motorway": return 130;
            case "DK:trunk": return 80;
            case "DK:living_street": return 15;
            default: break;
        }
        if (s.startsWith("DK:zone")) { try { return Integer.parseInt(s.substring(7)); } catch (Exception ignored) { } }
        try {
            String num = s.split("[ ;]")[0];
            int v = Integer.parseInt(num);
            if (s.contains("mph")) v = (int) Math.round(v * 1.609);
            return v > 0 && v <= 150 ? v : -1;
        } catch (Exception e) { return -1; }
    }

    /** Kompakt format på disken: [[id,limF,limB,est,oneway,[lat,lon,lat,lon…]],…] */
    static String encode(List<Way> ws) {
        StringBuilder sb = new StringBuilder(ws.size() * 120).append('[');
        for (int i = 0; i < ws.size(); i++) {
            Way w = ws.get(i);
            if (i > 0) sb.append(',');
            sb.append('[').append(w.id).append(',').append(w.limF).append(',').append(w.limB).append(',')
              .append(w.est ? 1 : 0).append(',').append(w.oneway ? 1 : 0).append(",[");
            for (int k = 0; k < w.lat.length; k++) {
                if (k > 0) sb.append(',');
                sb.append(String.format(Locale.ROOT, "%.6f,%.6f", w.lat[k], w.lon[k]));
            }
            sb.append("]]");
        }
        return sb.append(']').toString();
    }

    static List<Way> decode(String s) throws Exception {
        JSONArray arr = new JSONArray(s);
        List<Way> out = new ArrayList<>(arr.length());
        for (int i = 0; i < arr.length(); i++) {
            JSONArray a = arr.getJSONArray(i);
            Way w = new Way(); w.id = a.getLong(0); w.limF = a.getInt(1); w.limB = a.getInt(2); w.est = a.getInt(3) == 1; w.oneway = a.getInt(4) == 1;
            JSONArray c = a.getJSONArray(5); int n = c.length() / 2;
            w.lat = new double[n]; w.lon = new double[n];
            for (int k = 0; k < n; k++) { w.lat[k] = c.getDouble(2 * k); w.lon[k] = c.getDouble(2 * k + 1); }
            out.add(w);
        }
        return out;
    }
}
