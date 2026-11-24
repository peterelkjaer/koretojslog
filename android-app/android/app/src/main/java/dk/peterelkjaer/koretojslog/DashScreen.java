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
    private final SpeedLimitFetcher limits = new SpeedLimitFetcher();
    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

    public DashScreen(@NonNull CarContext carContext) {
        super(carContext);
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
    @Override public void onDestroy(@NonNull LifecycleOwner owner) { handler.removeCallbacks(ticker); stopLocation(); limits.shutdown(); }

    private void startLocation() {
        fused = LocationServices.getFusedLocationProviderClient(getCarContext());
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000).setMinUpdateIntervalMillis(500).build();
        callback = new LocationCallback() {
            @Override public void onLocationResult(@NonNull LocationResult r) {
                Location l = r.getLastLocation(); if (l == null) return;
                speedKmh = l.hasSpeed() ? l.getSpeed() * 3.6f : -1; lastFix = System.currentTimeMillis();
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

    private void render(Canvas c) {
        c.drawColor(Color.rgb(18, 18, 18));
        Rect a = visible != null && !visible.isEmpty() ? visible : new Rect(0, 0, width, height);
        int aw = a.width(), ah = a.height();
        if (aw <= 0 || ah <= 0) return;
        CarData.Dash d = CarData.compute(getCarContext());
        float unit = Math.min(ah, aw / 1.6f);

        // Servicelampe øverst til højre
        if (d.service > 0) {
            int col = d.service == 2 ? Color.rgb(226, 75, 74) : Color.rgb(239, 159, 39);
            float isz = unit * 0.11f;
            p.setColor(col); p.setTypeface(Typeface.DEFAULT_BOLD); p.setTextSize(unit * 0.07f); p.setTextAlign(Paint.Align.RIGHT);
            float tx = a.right - unit * 0.04f, ty = a.top + unit * 0.04f + isz * 0.75f;
            c.drawText("Service", tx, ty, p);
            float textW = p.measureText("Service");
            Drawable ic = ContextCompat.getDrawable(getCarContext(), R.drawable.ic_service);
            if (ic != null) {
                ic = ic.mutate(); ic.setTint(col);
                int right = (int) (tx - textW - unit * 0.02f), top = (int) (a.top + unit * 0.04f);
                ic.setBounds(right - (int) isz, top, right, top + (int) isz); ic.draw(c);
            }
        }

        // Stor hastighed
        boolean fresh = System.currentTimeMillis() - lastFix < 5000 && speedKmh >= 0;
        String sp = fresh ? String.valueOf(Math.round(speedKmh < 3 ? 0 : speedKmh)) : "–";
        int limit = d.speedLimitOn ? limits.current() : -1;
        float bottomH = unit * 0.24f;
        float midY = a.top + (ah - bottomH) * 0.52f;
        p.setTextAlign(Paint.Align.CENTER); p.setTypeface(Typeface.DEFAULT_BOLD);
        p.setTextSize(unit * 0.42f);
        float speedW = p.measureText(sp);
        float signR = unit * 0.11f;
        float groupW = speedW + (limit > 0 ? signR * 2 + unit * 0.08f : 0);
        float sx = a.left + aw / 2f - groupW / 2f + speedW / 2f;
        boolean over = limit > 0 && fresh && speedKmh > limit + 3;
        p.setColor(over ? Color.rgb(240, 149, 149) : Color.WHITE);
        c.drawText(sp, sx, midY + unit * 0.12f, p);
        p.setColor(Color.rgb(170, 170, 170)); p.setTypeface(Typeface.DEFAULT); p.setTextSize(unit * 0.065f);
        c.drawText("km/t", sx, midY + unit * 0.22f, p);

        // Hastighedsgrænse som skilt
        if (limit > 0) {
            float cx = sx + speedW / 2f + unit * 0.08f + signR, cy = midY - unit * 0.02f;
            p.setStyle(Paint.Style.FILL); p.setColor(Color.WHITE); c.drawCircle(cx, cy, signR, p);
            p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(signR * 0.22f); p.setColor(Color.rgb(214, 44, 44));
            c.drawCircle(cx, cy, signR - signR * 0.11f, p);
            p.setStyle(Paint.Style.FILL); p.setColor(Color.rgb(17, 17, 17)); p.setTypeface(Typeface.DEFAULT_BOLD);
            p.setTextSize(signR * (limit >= 100 ? 0.75f : 0.9f));
            c.drawText(String.valueOf(limit), cx, cy + signR * 0.32f, p);
        }

        // Tre små tal i bunden
        float lineY = a.bottom - bottomH;
        p.setColor(Color.rgb(44, 44, 44)); p.setStrokeWidth(2); c.drawLine(a.left + unit * 0.04f, lineY, a.right - unit * 0.04f, lineY, p);
        String[] labels = {"Tur", "Km-stand", "Rækkevidde"};
        String[] vals = {
            d.tripKm >= 0 ? fmt(d.tripKm, 1) + " km" : "–",
            d.odo >= 0 ? fmt(Math.floor(d.odo), 0) : "–",
            d.range >= 0 ? "ca. " + fmt(Math.round(d.range / 5.0) * 5, 0) + " km" : "–"
        };
        for (int i = 0; i < 3; i++) {
            float cx = a.left + aw * (i * 2 + 1) / 6f;
            p.setTypeface(Typeface.DEFAULT); p.setTextSize(unit * 0.055f); p.setColor(Color.rgb(154, 154, 154));
            c.drawText(labels[i], cx, lineY + bottomH * 0.38f, p);
            p.setTypeface(Typeface.DEFAULT_BOLD); p.setTextSize(unit * 0.08f); p.setColor(Color.WHITE);
            c.drawText(vals[i], cx, lineY + bottomH * 0.8f, p);
        }
    }
}
