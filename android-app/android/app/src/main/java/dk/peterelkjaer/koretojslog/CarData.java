package dk.peterelkjaer.koretojslog;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

/**
 * Tallene til Android Auto-skærmen. Appen (web-delen) gemmer et øjebliksbillede pr. køretøj
 * (kilometerstand, rækkevidde, påmindelser); her lægges kilometer fra igangværende og
 * endnu ikke hentede ture til, så tallene er levende under kørslen.
 */
public class CarData {
    public static class Dash {
        String name = "";
        double tripKm = -1, odo = -1, range = -1;
        int service = 0;            // 0 = ok, 1 = snart (gul), 2 = overskredet (rød)
        boolean speedLimitOn = true;
    }

    static void save(Context c, String json) { TripStore.prefs(c).edit().putString("carData", json).apply(); }

    static Dash compute(Context c) {
        Dash d = new Dash();
        try {
            JSONObject root = new JSONObject(TripStore.prefs(c).getString("carData", "{}"));
            d.speedLimitOn = root.optBoolean("speedLimit", true);
            int warnKm = root.optInt("warnKm", 1000), warnDays = root.optInt("warnDays", 30);
            long updated = root.optLong("updated", 0);
            JSONArray vs = root.optJSONArray("vehicles");
            if (vs == null || vs.length() == 0) return d;

            String addr = TripService.running ? TripService.activeAddress : TripStore.prefs(c).getString("lastAddress", null);
            JSONObject v = null;
            for (int i = 0; i < vs.length() && addr != null; i++) {
                JSONObject x = vs.getJSONObject(i);
                if (addr.equalsIgnoreCase(x.optString("address")) || addr.equalsIgnoreCase(x.optString("manual"))) { v = x; break; }
            }
            if (v == null) v = vs.getJSONObject(0);
            d.name = v.optString("name");
            double factor = v.optDouble("factor", 1);
            String vAddr = v.optString("address"), vManual = v.optString("manual");

            // Afsluttede ture, som appen endnu ikke har hentet
            double pendingKm = 0;
            JSONArray done = TripStore.listDone(c);
            for (int i = 0; i < done.length(); i++) {
                JSONObject t = done.getJSONObject(i);
                String ta = t.optString("address");
                if ((ta.equalsIgnoreCase(vAddr) || ta.equalsIgnoreCase(vManual)) && t.optLong("start") > updated)
                    pendingKm += t.optDouble("meters", 0) / 1000.0 * factor;
            }
            boolean mine = TripService.running && TripService.activeAddress != null
                && (TripService.activeAddress.equalsIgnoreCase(vAddr) || TripService.activeAddress.equalsIgnoreCase(vManual));
            double activeKm = mine ? TripService.activeMeters / 1000.0 * factor : 0;
            d.tripKm = mine ? activeKm : -1;

            if (!v.isNull("km")) d.odo = v.getDouble("km") + pendingKm + activeKm;
            if (!v.isNull("range")) d.range = Math.max(0, v.getDouble("range") - pendingKm - activeKm);

            JSONArray rems = v.optJSONArray("reminders");
            if (rems != null) for (int i = 0; i < rems.length(); i++) {
                JSONObject r = rems.getJSONObject(i);
                if (!r.isNull("nextKm") && d.odo >= 0) {
                    double left = r.getDouble("nextKm") - d.odo;
                    if (left <= 0) d.service = 2; else if (left <= warnKm) d.service = Math.max(d.service, 1);
                }
                String nd = r.optString("nextDate", "");
                if (!nd.isEmpty() && !"null".equals(nd)) {
                    long days = ChronoUnit.DAYS.between(LocalDate.now(), LocalDate.parse(nd));
                    if (days <= 0) d.service = 2; else if (days <= warnDays) d.service = Math.max(d.service, 1);
                }
            }
        } catch (Exception ignored) { }
        return d;
    }
}
