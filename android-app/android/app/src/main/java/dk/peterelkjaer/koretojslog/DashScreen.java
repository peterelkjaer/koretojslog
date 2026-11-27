package dk.peterelkjaer.koretojslog;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.location.Location;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;

import androidx.annotation.NonNull;
import androidx.car.app.AppManager;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.SurfaceCallback;
import androidx.car.app.SurfaceContainer;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.Locale;

/**
 * Køreskærmen i Android Auto: stor hastighed, hastighedsgrænse, tur-km, kilometerstand,
 * rækkevidde og en servicelampe. Tegnes direkte på skærmen (navigationsapp-skabelon).
 */
public class DashScreen extends Screen implements SurfaceCallback, DefaultLifecycleObserver {
    private Surface surface;
    private int width, height;
    private Rect visible;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() { @Override public void run() { draw(); handler.postDelayed(this, 1000); } };
    private FusedLocationProviderClient fused;
    private LocationCallback callback;
    private float speedKmh = -1;
    private long lastFix = 0;
    private final SpeedLimits limits;
    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

    public DashScreen(@NonNull CarContext carContext) {
        super(carContext);
        limits = SpeedLimits.get(carContext);
        getLifecycle().addObserver(this);
        carContext.getCarService(AppManager.class).setSurfaceCallback(this);
    }

    @NonNull @Override
    public Template onGetTemplate() {
        ActionStrip strip = new ActionStrip.Builder()
            .addAction(new Action.Builder().setTitle("Køretøjslog").setOnClickListener(this::draw).build())
            .build();
        return new NavigationTemplate.Builder().setActionStrip(strip).build();
    }

    @Override public void onCreate(@NonNull LifecycleOwner owner) { startLocation(); handler.post(ticker); }
    @Override public void onDestroy(@NonNull LifecycleOwner owner) { handler.removeCallbacks(ticker); stopLocation(); }

    private void startLocation() {
        fused = LocationServices.getFusedLocationProviderClient(getCarContext());
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000).setMinUpdateIntervalMillis(500).build();
        callback = new LocationCallback() {
            @Override public void onLocationResult(@NonNull LocationResult r) {
                Location l = r.getLastLocation(); if (l == null) return;
                speedKmh = l.hasSpeed() ? l.getSpeed() * 3.6f : -1; lastFix = System.currentTimeMillis();
                if (lastLoc != null && (!l.hasAccuracy() || l.getAccuracy() < 30)) { float m = lastLoc.distanceTo(l); if (m < 200) sessionMeters += m; }
                lastLoc = l;
                limits.onLocation(l);
            }
        };
        try { fused.requestLocationUpdates(req, callback, Looper.getMainLooper()); } catch (SecurityException ignored) { }
    }

    private void stopLocation() { if (fused != null && callback != null) fused.removeLocationUpdates(callback); }

    // ---- SurfaceCallback ----
    @Override public void onSurfaceAvailable(@NonNull SurfaceContainer c) { surface = c.getSurface(); width = c.getWidth(); height = c.getHeight(); draw(); }
    @Override public void onSurfaceDestroyed(@NonNull SurfaceContainer c) { surface = null; }
    @Override public void onVisibleAreaChanged(@NonNull Rect r) { visible = new Rect(r); draw(); }
    @Override public void onStableAreaChanged(@NonNull Rect r) { }

    private void draw() {
        Surface s = surface;
        if (s == null || !s.isValid()) return;
        Canvas c;
        try { c = s.lockCanvas(null); } catch (Exception e) { return; }
        try { render(c); } finally { s.unlockCanvasAndPost(c); }
    }

    private static String fmt(double v, int dec) {
        String f = String.format(Locale.ROOT, "%,." + dec + "f", v);
        return f.replace(',', 'X').replace('.', ',').replace('X', '.');
    }

    // ---- lyde ----
    private Location lastLoc;
    private double sessionMeters = 0, alarmAt = -1;
    private int prevService = 0, overTicks = 0, overLimit = -1;
    private boolean overFired = false;
    private long lastAheadKey = 0;

    private void evaluateSounds(CarData.Dash d, SpeedLimits.Result r) {
        boolean fresh = System.currentTimeMillis() - lastFix < 5000 && speedKmh >= 0;
        // Fartgrænse overskredet (kun registrerede grænser, ikke anslåede)
        if (r.limit > 0 && !r.est && fresh && speedKmh > r.limit + 3) {
            if (r.limit != overLimit) { overFired = false; overLimit = r.limit; }
            if (++overTicks >= 2 && !overFired) { overFired = true; if (d.sndOver) Sounds.ding(getCarContext()); }
        } else {
            overTicks = 0;
            if (r.limit <= 0 || !fresh || speedKmh <= r.limit) { overFired = false; overLimit = -1; }
        }
        // Ny grænse forude
        if (r.ahead > 0 && r.aheadKey != lastAheadKey) { lastAheadKey = r.aheadKey; if (d.sndAhead && d.speedLimitOn) Sounds.bip(getCarContext()); }
        if (r.ahead <= 0) lastAheadKey = 0;
        // Service: gul = ding én gang, rød = biiip og igen for hver 20 km
        if (d.service == 1 && prevService == 0 && d.sndService) Sounds.ding(getCarContext());
        if (d.service == 2) {
            if (prevService != 2 || (alarmAt >= 0 && sessionMeters - alarmAt >= 20_000)) {
                alarmAt = sessionMeters; if (d.sndService) Sounds.alarm(getCarContext());
            }
        } else alarmAt = -1;
        prevService = d.service;
    }

    private void render(Canvas c) {
        c.drawColor(Color.rgb(18, 18, 18));
        Rect a = visible != null && !visible.isEmpty() ? visible : new Rect(0, 0, width, height);
        int aw = a.width(), ah = a.height();
        if (aw <= 0 || ah <= 0) return;
        CarData.Dash d = CarData.compute(getCarContext());
        SpeedLimits.Result r = d.speedLimitOn ? limits.current() : new SpeedLimits.Result();
        evaluateSounds(d, r);
        float unit = Math.min(ah, aw / 1.6f), pad = unit * 0.04f;

        // ---- Lamperækken øverst til venstre (plads til flere lamper med tiden) ----
        float lampH = unit * 0.15f, lx = a.left + pad;
        if (d.service > 0) lx = drawLamp(c, lx, a.top + pad, unit, R.drawable.ic_service, "Service",
            d.service == 2 ? Color.rgb(226, 75, 74) : Color.rgb(239, 159, 39));

        // ---- Bunden: tur, km-stand, rækkevidde ----
        float bottomH = unit * 0.30f, lineY = a.bottom - bottomH;
        p.setStyle(Paint.Style.FILL);
        p.setColor(Color.rgb(48, 48, 48)); p.setStrokeWidth(2); c.drawLine(a.left + pad, lineY, a.right - pad, lineY, p);
        String[] labels = {"Tur", "Km-stand", "Rækkevidde"};
        String[] vals = {
            d.tripKm >= 0 ? fmt(d.tripKm, 1) + " km" : "–",
            d.odo >= 0 ? fmt(Math.floor(d.odo), 0) : "–",
            d.range >= 0 ? fmt(Math.round(d.range / 5.0) * 5, 0) + " km" : "–"
        };
        p.setTextAlign(Paint.Align.CENTER);
        float colW = aw / 3f - pad;
        for (int i = 0; i < 3; i++) {
            float cx = a.left + aw * (i * 2 + 1) / 6f;
            p.setTypeface(Typeface.DEFAULT); p.setTextSize(unit * 0.065f); p.setColor(Color.rgb(160, 160, 160));
            c.drawText(labels[i], cx, lineY + bottomH * 0.33f, p);
            p.setTypeface(Typeface.DEFAULT_BOLD); p.setColor(Color.WHITE);
            fit(vals[i], unit * 0.12f, colW);
            c.drawText(vals[i], cx, lineY + bottomH * 0.82f, p);
        }

        // ---- Midten: stor hastighed og skilt i samme højde ----
        float top = a.top + lampH + pad * 0.5f, midH = lineY - top;
        boolean fresh = System.currentTimeMillis() - lastFix < 5000 && speedKmh >= 0;
        String sp = fresh ? String.valueOf(Math.round(speedKmh < 3 ? 0 : speedKmh)) : "–";
        float S = Math.min(unit * 0.60f, (midH - unit * 0.10f) / 0.74f);
        boolean showSign = r.limit > 0;
        p.setTypeface(Typeface.DEFAULT_BOLD);
        for (int k = 0; k < 6; k++) {
            p.setTextSize(S);
            float w = Math.max(p.measureText(sp), p.measureText("188"));
            float D = S * 0.72f * 1.2f;
            float g = w + (showSign || r.ahead > 0 ? unit * 0.10f + D : 0) + (showSign && r.ahead > 0 ? D * 0.30f : 0);
            if (g <= aw - 2 * pad) break;
            S *= 0.92f;
        }
        p.setTextSize(S);
        float speedW = Math.max(p.measureText(sp), p.measureText("188"));
        float digitH = S * 0.72f, R2 = digitH * 1.2f / 2f;
        boolean anySign = showSign || r.ahead > 0;
        float groupW = speedW + (anySign ? unit * 0.10f + R2 * 2 : 0) + (showSign && r.ahead > 0 ? R2 * 0.6f : 0);
        float sx = a.left + aw / 2f - groupW / 2f + speedW / 2f;
        float baseY = top + (midH - unit * 0.10f) / 2f + digitH / 2f;
        boolean over = r.limit > 0 && !r.est && fresh && speedKmh > r.limit + 3;
        p.setTextAlign(Paint.Align.CENTER);
        p.setColor(over ? Color.rgb(240, 120, 120) : Color.WHITE);
        c.drawText(sp, sx, baseY, p);
        p.setColor(Color.rgb(160, 160, 160)); p.setTypeface(Typeface.DEFAULT); p.setTextSize(unit * 0.07f);
        c.drawText("km/t", sx, baseY + unit * 0.09f, p);

        float cx = sx + speedW / 2f + unit * 0.10f + R2, cy = baseY - digitH / 2f;
        if (showSign) {
            if (r.est) sign(c, cx, cy, R2, r.limit, Color.rgb(58, 58, 58), Color.rgb(140, 140, 140), Color.rgb(205, 205, 205));
            else sign(c, cx, cy, R2, r.limit, Color.WHITE, Color.rgb(214, 44, 44), Color.rgb(17, 17, 17));
        }
        if (r.ahead > 0) {
            float rr = R2 * 0.55f;
            float ax = showSign ? cx + R2 * 1.0f : cx, ay = showSign ? cy - R2 * 0.95f : cy;
            p.setStyle(Paint.Style.FILL); p.setColor(Color.rgb(18, 18, 18)); c.drawCircle(ax, ay, rr * 1.12f, p);
            sign(c, ax, ay, rr, r.ahead, Color.WHITE, Color.rgb(135, 135, 135), Color.rgb(17, 17, 17));
        }
    }

    private void sign(Canvas c, float cx, float cy, float rad, int limit, int fill, int ring, int text) {
        p.setStyle(Paint.Style.FILL); p.setColor(fill); c.drawCircle(cx, cy, rad, p);
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(rad * 0.2f); p.setColor(ring);
        c.drawCircle(cx, cy, rad - rad * 0.1f, p);
        p.setStyle(Paint.Style.FILL); p.setColor(text); p.setTypeface(Typeface.DEFAULT_BOLD); p.setTextAlign(Paint.Align.CENTER);
        p.setTextSize(rad * (limit >= 100 ? 0.72f : 0.95f));
        c.drawText(String.valueOf(limit), cx, cy + p.getTextSize() * 0.36f, p);
    }

    /** Tegner en lampe (ikon + kort ord) og returnerer x til den næste. */
    private float drawLamp(Canvas c, float x, float y, float unit, int icon, String word, int col) {
        float isz = unit * 0.12f;
        Drawable ic = ContextCompat.getDrawable(getCarContext(), icon);
        if (ic != null) { ic = ic.mutate(); ic.setTint(col); ic.setBounds((int) x, (int) y, (int) (x + isz), (int) (y + isz)); ic.draw(c); }
        p.setStyle(Paint.Style.FILL); p.setColor(col); p.setTypeface(Typeface.DEFAULT_BOLD); p.setTextSize(unit * 0.09f); p.setTextAlign(Paint.Align.LEFT);
        float tx = x + isz + unit * 0.02f;
        c.drawText(word, tx, y + isz * 0.5f + unit * 0.09f * 0.36f, p);
        return tx + p.measureText(word) + unit * 0.06f;
    }

    private void fit(String s, float size, float maxW) {
        p.setTextSize(size);
        float w = p.measureText(s);
        if (w > maxW) p.setTextSize(size * maxW / w);
    }
}
