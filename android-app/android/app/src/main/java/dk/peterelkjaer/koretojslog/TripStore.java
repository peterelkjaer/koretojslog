package dk.peterelkjaer.koretojslog;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Gemmer ture som JSON-filer i appens private mappe, indtil web-delen af appen har hentet dem.
 *  - trips/current.json : turen der er i gang (gemmes løbende, så den overlever genstart)
 *  - trips/done/*.json  : afsluttede ture, der venter på at blive hentet
 * Indeholder også listen over Bluetooth-enheder, der skal overvåges (adresse -> navn/køretøj).
 */
public class TripStore {
    static final String PREFS = "koretojslog_trips";
    static final double MIN_TRIP_METERS = 300;

    public static class Trip {
        String id, address, name;
        long start, end, lastUpdate;
        double meters, maxSpeed;
        List<double[]> points = new ArrayList<>();
    }

    static File dir(Context c) { File d = new File(c.getFilesDir(), "trips"); d.mkdirs(); return d; }
    static File doneDir(Context c) { File d = new File(dir(c), "done"); d.mkdirs(); return d; }
    static File currentFile(Context c) { return new File(dir(c), "current.json"); }

    // ---- Overvågede enheder ----
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static String norm(String a) { return a == null ? "" : a.trim().toUpperCase(); }
    static boolean isWatched(Context c, String address) { return prefs(c).contains("watch_" + norm(address)); }
    static String watchedName(Context c, String address) { return prefs(c).getString("watch_" + norm(address), address); }
    static void watch(Context c, String address, String name) { prefs(c).edit().putString("watch_" + norm(address), name).apply(); }
    static void unwatch(Context c, String address) { prefs(c).edit().remove("watch_" + norm(address)).apply(); }
    static void logEvent(Context c, String msg) {
        SharedPreferences p = prefs(c);
        String log = p.getString("log", "");
        String line = new java.text.SimpleDateFormat("dd/MM HH:mm:ss", java.util.Locale.ROOT).format(new java.util.Date()) + " " + msg;
        String all = line + "\n" + log;
        if (all.length() > 4000) all = all.substring(0, 4000);
        p.edit().putString("log", all).apply();
    }

    // ---- Tur i gang ----
    static Trip newTrip(String address, String name) {
        Trip t = new Trip();
        t.start = System.currentTimeMillis();
        t.id = "t" + t.start;
        t.address = norm(address);
        t.name = name;
        t.lastUpdate = t.start;
        return t;
    }

    static void saveCurrent(Context c, Trip t) {
        try {
            JSONObject o = toJson(t, false);
            JSONArray pts = new JSONArray();
            for (double[] p : t.points) pts.put(new JSONArray().put(p[0]).put(p[1]));
            o.put("raw", pts);
            write(currentFile(c), o.toString());
        } catch (Exception ignored) { }
    }

    static Trip loadCurrent(Context c) {
        try {
            File f = currentFile(c);
            if (!f.exists()) return null;
            JSONObject o = new JSONObject(read(f));
            Trip t = new Trip();
            t.id = o.getString("id"); t.address = o.getString("address"); t.name = o.optString("name");
            t.start = o.getLong("start"); t.lastUpdate = o.optLong("lastUpdate", t.start);
            t.meters = o.optDouble("meters", 0); t.maxSpeed = o.optDouble("maxSpeed", 0);
            JSONArray raw = o.optJSONArray("raw");
            if (raw != null) for (int i = 0; i < raw.length(); i++) {
                JSONArray p = raw.getJSONArray(i); t.points.add(new double[]{p.getDouble(0), p.getDouble(1)});
            }
            return t;
        } catch (Exception e) { return null; }
    }

    /** Afslutter turen: gemmer den som færdig (hvis den er lang nok) og sletter current.json. */
    static void finish(Context c, Trip t) {
        try {
            t.end = Math.max(t.lastUpdate, t.start);
            if (t.meters >= MIN_TRIP_METERS) {
                JSONObject o = toJson(t, true);
                write(new File(doneDir(c), t.id + ".json"), o.toString());
                logEvent(c, "Tur gemt: " + Math.round(t.meters / 100) / 10.0 + " km (" + t.name + ")");
            } else {
                logEvent(c, "Tur kasseret (kun " + Math.round(t.meters) + " m)");
            }
        } catch (Exception e) {
            logEvent(c, "Fejl ved gem af tur: " + e.getMessage());
        }
        currentFile(c).delete();
    }

    static JSONObject toJson(Trip t, boolean withPolyline) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", t.id); o.put("address", t.address); o.put("name", t.name);
        o.put("start", t.start); o.put("end", t.end); o.put("lastUpdate", t.lastUpdate);
        o.put("meters", t.meters); o.put("maxSpeed", t.maxSpeed);
        if (withPolyline) o.put("poly", encode(simplify(t.points)));
        return o;
    }

    static JSONArray listDone(Context c) {
        JSONArray arr = new JSONArray();
        File[] files = doneDir(c).listFiles();
        if (files == null) return arr;
        for (File f : files) {
            try { arr.put(new JSONObject(read(f))); } catch (Exception ignored) { }
        }
        return arr;
    }

    static void ack(Context c, List<String> ids) {
        for (String id : ids) new File(doneDir(c), id.replaceAll("[^A-Za-z0-9_-]", "") + ".json").delete();
    }

    // ---- Forenkling af ruten (Douglas–Peucker) og Google-polyline-kodning ----
    static List<double[]> simplify(List<double[]> pts) {
        if (pts.size() <= 2) return pts;
        double tol = 6; // meter
        List<double[]> out = dp(pts, tol);
        while (out.size() > 1500) { tol *= 1.6; out = dp(pts, tol); }
        return out;
    }

    private static List<double[]> dp(List<double[]> pts, double tol) {
        boolean[] keep = new boolean[pts.size()];
        keep[0] = keep[pts.size() - 1] = true;
        java.util.ArrayDeque<int[]> stack = new java.util.ArrayDeque<>();
        stack.push(new int[]{0, pts.size() - 1});
        while (!stack.isEmpty()) {
            int[] r = stack.pop();
            double maxD = 0; int idx = -1;
            for (int i = r[0] + 1; i < r[1]; i++) {
                double d = segDist(pts.get(i), pts.get(r[0]), pts.get(r[1]));
                if (d > maxD) { maxD = d; idx = i; }
            }
            if (idx >= 0 && maxD > tol) { keep[idx] = true; stack.push(new int[]{r[0], idx}); stack.push(new int[]{idx, r[1]}); }
        }
        List<double[]> out = new ArrayList<>();
        for (int i = 0; i < pts.size(); i++) if (keep[i]) out.add(pts.get(i));
        return out;
    }

    private static double segDist(double[] p, double[] a, double[] b) {
        double k = Math.cos(Math.toRadians(a[0])) * 111320, m = 110540;
        double px = (p[1] - a[1]) * k, py = (p[0] - a[0]) * m, bx = (b[1] - a[1]) * k, by = (b[0] - a[0]) * m;
        double len = bx * bx + by * by;
        double t = len == 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len));
        double dx = px - t * bx, dy = py - t * by;
        return Math.sqrt(dx * dx + dy * dy);
    }

    static String encode(List<double[]> pts) {
        StringBuilder sb = new StringBuilder();
        long lastLat = 0, lastLng = 0;
        for (double[] p : pts) {
            long lat = Math.round(p[0] * 1e5), lng = Math.round(p[1] * 1e5);
            enc(lat - lastLat, sb); enc(lng - lastLng, sb);
            lastLat = lat; lastLng = lng;
        }
        return sb.toString();
    }

    private static void enc(long v, StringBuilder sb) {
        v = v < 0 ? ~(v << 1) : (v << 1);
        while (v >= 0x20) { sb.append((char) ((0x20 | (v & 0x1f)) + 63)); v >>= 5; }
        sb.append((char) (v + 63));
    }

    // ---- Filer ----
    static void write(File f, String s) throws Exception {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(s.getBytes(StandardCharsets.UTF_8)); }
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
    }

    static String read(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int n = 0; while (n < b.length) { int r = in.read(b, n, b.length - n); if (r < 0) break; n += r; }
            return new String(b, 0, n, StandardCharsets.UTF_8);
        }
    }
}
