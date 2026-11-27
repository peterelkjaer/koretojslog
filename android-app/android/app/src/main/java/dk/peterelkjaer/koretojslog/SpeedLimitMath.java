package dk.peterelkjaer.koretojslog;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Ren geometri til fartgrænserne (ingen Android-afhængigheder, så den kan testes for sig). */
final class SpeedLimitMath {
    private SpeedLimitMath() { }

    static class Way {
        long id; int limF, limB; boolean est, oneway; double[] lat, lon;
        int lim(int dir) { return dir >= 0 ? limF : limB; }
    }
    static class Hit { Way way; int seg; int dir; double t; double d; }
    static class Ahead { Way way; int limit; double dist; }

    static double dist(double lat1, double lon1, double lat2, double lon2) {
        double kx = Math.cos(Math.toRadians(lat1)) * 111_320, ky = 110_540;
        double dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * ky;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Kurs i grader (0 = nord, 90 = øst). */
    static double bearing(double lat1, double lon1, double lat2, double lon2) {
        double kx = Math.cos(Math.toRadians(lat1)) * 111_320, ky = 110_540;
        double b = Math.toDegrees(Math.atan2((lon2 - lon1) * kx, (lat2 - lat1) * ky));
        return b < 0 ? b + 360 : b;
    }

    static double angDiff(double a, double b) {
        double d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
    }

    static long nodeKey(double lat, double lon) {
        return Math.round(lat * 1e6) * 1_000_000_000L + Math.round(lon * 1e6) + 500_000_000L;
    }

    static Map<Long, List<int[]>> buildIndex(List<Way> ws) {
        Map<Long, List<int[]>> m = new HashMap<>();
        for (int i = 0; i < ws.size(); i++) {
            Way w = ws.get(i);
            for (int k = 0; k < w.lat.length; k++) {
                long key = nodeKey(w.lat[k], w.lon[k]);
                List<int[]> l = m.get(key);
                if (l == null) { l = new ArrayList<>(2); m.put(key, l); }
                l.add(new int[]{i, k});
            }
        }
        return m;
    }

    /**
     * Finder den vej, man kører på: tæt på (≤ maxD m) og i samme retning som kursen.
     * Den hidtidige vej foretrækkes en smule, så den ikke skifter frem og tilbage i kryds.
     */
    static Hit bestWay(List<Way> ws, double lat, double lon, double brg, Way prev, int prevDir, double maxD) {
        double kx = Math.cos(Math.toRadians(lat)) * 111_320, ky = 110_540;
        Hit best = null; double bestScore = Double.MAX_VALUE;
        for (Way w : ws) {
            for (int i = 0; i + 1 < w.lat.length; i++) {
                double ax = (w.lon[i] - lon) * kx, ay = (w.lat[i] - lat) * ky;
                double bx = (w.lon[i + 1] - lon) * kx, by = (w.lat[i + 1] - lat) * ky;
                double dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
                double t = len == 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
                double px = ax + t * dx, py = ay + t * dy;
                double d = Math.sqrt(px * px + py * py);
                if (d > maxD) continue;
                int dir = 1; double pen = 0;
                if (brg >= 0 && len > 1) {
                    double sb = Math.toDegrees(Math.atan2(dx, dy)); if (sb < 0) sb += 360;
                    double a = angDiff(brg, sb);
                    if (a > 90) { dir = -1; a = 180 - a; }
                    if (w.oneway && dir < 0) continue;      // mod kørselsretningen på ensrettet vej
                    if (a > 55) continue;                   // krydsende vej
                    pen = a * 0.35;
                } else if (w == prev) dir = prevDir;
                double score = d + pen - (w == prev ? 8 : 0);
                if (score < bestScore) {
                    bestScore = score;
                    best = new Hit(); best.way = w; best.seg = i; best.dir = dir; best.t = t; best.d = d;
                }
            }
        }
        return best;
    }

    /**
     * Følger vejen fremad (også over på den vej, der fortsætter mest lige ud) og returnerer
     * den første ændring af grænsen inden for max meter. Anslåede grænser varsles ikke.
     */
    static Ahead lookAhead(List<Way> ws, Map<Long, List<int[]>> idx, Hit hit, double lat, double lon, double max) {
        Way w = hit.way; int dir = hit.dir, seg = hit.seg;
        int curLim = w.lim(dir);
        double plat = w.lat[seg] + (w.lat[seg + 1] - w.lat[seg]) * hit.t;
        double plon = w.lon[seg] + (w.lon[seg + 1] - w.lon[seg]) * hit.t;
        int v = dir > 0 ? seg + 1 : seg;
        double acc = dist(plat, plon, w.lat[v], w.lon[v]);
        double inBrg = dir > 0 ? bearing(w.lat[seg], w.lon[seg], w.lat[seg + 1], w.lon[seg + 1])
                               : bearing(w.lat[seg + 1], w.lon[seg + 1], w.lat[seg], w.lon[seg]);
        Set<Long> visited = new HashSet<>(); visited.add(w.id);
        for (int iter = 0; iter < 400 && acc <= max; iter++) {
            int nv = v + dir;
            if (nv >= 0 && nv < w.lat.length) {
                double sd = dist(w.lat[v], w.lon[v], w.lat[nv], w.lon[nv]);
                if (sd > 0.5) inBrg = bearing(w.lat[v], w.lon[v], w.lat[nv], w.lon[nv]);
                acc += sd; v = nv; continue;
            }
            // Vejens ende: find den vej, der fortsætter mest lige ud
            List<int[]> list = idx.get(nodeKey(w.lat[v], w.lon[v]));
            if (list == null) return null;
            Way bw = null; int bk = 0, bd = 0; double bdiff = 999;
            for (int[] e : list) {
                Way x = ws.get(e[0]);
                if (x == w || visited.contains(x.id)) continue;
                for (int d = -1; d <= 1; d += 2) {
                    int nk = e[1] + d;
                    if (nk < 0 || nk >= x.lat.length) continue;
                    if (x.oneway && d < 0) continue;
                    double diff = angDiff(inBrg, bearing(x.lat[e[1]], x.lon[e[1]], x.lat[nk], x.lon[nk]));
                    if (diff < bdiff) { bdiff = diff; bw = x; bk = e[1]; bd = d; }
                }
            }
            if (bw == null || bdiff > 50) return null;
            int lim = bw.lim(bd);
            if (lim != curLim) {
                if (bw.est) return null;
                Ahead a = new Ahead(); a.way = bw; a.limit = lim; a.dist = acc; return a;
            }
            w = bw; v = bk; dir = bd; visited.add(w.id);
        }
        return null;
    }
}
