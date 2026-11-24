package dk.peterelkjaer.koretojslog;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

/**
 * Forgrundstjeneste, der måler en tur med GPS, mens telefonen er forbundet til køretøjets skærm.
 * Ved afbrydelse ventes 2 minutter, så korte udfald i Bluetooth ikke deler turen op.
 */
public class TripService extends Service {
    static final String ACTION_START = "dk.peterelkjaer.koretojslog.TRIP_START";
    static final String ACTION_STOP = "dk.peterelkjaer.koretojslog.TRIP_STOP";        // med 2 min. respit
    static final String ACTION_STOP_NOW = "dk.peterelkjaer.koretojslog.TRIP_STOP_NOW";
    static final String EXTRA_ADDRESS = "address";
    static final String EXTRA_NAME = "name";
    static final long GRACE_MS = 120_000;
    static final int NOTIF_ID = 4711;
    static final String CHANNEL = "trip";

    static volatile boolean running = false;
    static volatile String activeAddress = null;
    static volatile String activeName = null;
    static volatile double activeMeters = 0;
    static volatile long activeStart = 0;

    private FusedLocationProviderClient fused;
    private LocationCallback callback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable finalizer = this::finishTrip;
    private TripStore.Trip trip;
    private Location last;
    private long lastSave = 0;
    private boolean stopping = false;

    /** Starter eller stopper tjenesten sikkert (fejl logges i stedet for at crashe). */
    static void send(Context c, String action, String address, String name) {
        Intent i = new Intent(c, TripService.class).setAction(action);
        if (address != null) i.putExtra(EXTRA_ADDRESS, TripStore.norm(address));
        if (name != null) i.putExtra(EXTRA_NAME, name);
        try {
            if (ACTION_START.equals(action)) ContextCompat.startForegroundService(c, i);
            else if (running) c.startService(i);
        } catch (Exception e) {
            TripStore.logEvent(c, "Kunne ikke " + (ACTION_START.equals(action) ? "starte" : "stoppe") + " logning: " + e.getClass().getSimpleName());
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        // Gå i forgrunden med det samme (krav fra Android)
        goForeground(trip != null ? trip.name : (intent != null ? intent.getStringExtra(EXTRA_NAME) : null));
        if (action == null) { // genstartet af systemet: genoptag turen, hvis der er en
            TripStore.Trip cur = TripStore.loadCurrent(this);
            if (cur == null) { stopSelfSafely(); return START_NOT_STICKY; }
            trip = cur; beginUpdates(); return START_STICKY;
        }
        switch (action) {
            case ACTION_START: {
                String address = intent.getStringExtra(EXTRA_ADDRESS);
                String name = intent.getStringExtra(EXTRA_NAME);
                if (name == null) name = TripStore.watchedName(this, address);
                TripStore.prefs(this).edit().putString("lastAddress", TripStore.norm(address)).apply();
                handler.removeCallbacks(finalizer);
                stopping = false;
                if (trip != null && !TripStore.norm(address).equals(trip.address)) { finishTripKeepService(); }
                if (trip == null) {
                    TripStore.Trip cur = TripStore.loadCurrent(this);
                    if (cur != null && cur.address.equals(TripStore.norm(address)) && System.currentTimeMillis() - cur.lastUpdate < 30 * 60_000) {
                        trip = cur; TripStore.logEvent(this, "Tur genoptaget (" + name + ")");
                    } else {
                        if (cur != null) TripStore.finish(this, cur);
                        trip = TripStore.newTrip(address, name);
                        TripStore.logEvent(this, "Tur startet (" + name + ")");
                    }
                }
                beginUpdates();
                updateNotification();
                break;
            }
            case ACTION_STOP:
                if (trip == null) { stopSelfSafely(); break; }
                stopping = true;
                handler.removeCallbacks(finalizer);
                handler.postDelayed(finalizer, GRACE_MS);
                updateNotification();
                TripStore.logEvent(this, "Forbindelse afbrudt – afslutter om 2 min.");
                break;
            case ACTION_STOP_NOW:
                handler.removeCallbacks(finalizer);
                finishTrip();
                break;
        }
        return START_STICKY;
    }

    private void goForeground(String name) {
        createChannel();
        Notification n = buildNotification(name);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n, type);
        } catch (Exception e) {
            TripStore.logEvent(this, "Forgrundstjeneste afvist: " + e.getClass().getSimpleName());
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Turlogning", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Vises, mens en tur bliver logget");
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String name) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        double km = trip != null ? trip.meters / 1000.0 : 0;
        String title = stopping ? "Afslutter tur …" : "Logger tur" + (name != null ? " – " + name : "");
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(title)
            .setContentText(String.format(java.util.Locale.ROOT, "%.1f km", km).replace('.', ','))
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setContentIntent(pi)
            .build();
    }

    private void updateNotification() {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.notify(NOTIF_ID, buildNotification(trip != null ? trip.name : null));
        } catch (Exception ignored) { }
        running = trip != null;
        activeAddress = trip != null ? trip.address : null;
        activeName = trip != null ? trip.name : null;
        activeMeters = trip != null ? trip.meters : 0;
        activeStart = trip != null ? trip.start : 0;
    }

    private void beginUpdates() {
        running = true;
        if (callback != null) return;
        fused = LocationServices.getFusedLocationProviderClient(this);
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000)
            .setMinUpdateIntervalMillis(1000)
            .setMinUpdateDistanceMeters(5)
            .build();
        callback = new LocationCallback() {
            @Override public void onLocationResult(@NonNull LocationResult result) {
                for (Location l : result.getLocations()) onLocation(l);
            }
        };
        try {
            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (SecurityException e) {
            TripStore.logEvent(this, "Mangler tilladelse til placering");
            callback = null;
        }
    }

    private void endUpdates() {
        if (fused != null && callback != null) fused.removeLocationUpdates(callback);
        callback = null;
    }

    private void onLocation(Location l) {
        if (trip == null) return;
        if (l.hasAccuracy() && l.getAccuracy() > 30) return;
        if (last != null) {
            float d = last.distanceTo(l);
            double dt = (l.getTime() - last.getTime()) / 1000.0;
            if (dt <= 0) return;
            double v = d / dt;
            if (v > 90) return;                                                     // urealistisk spring
            float acc = l.hasAccuracy() ? l.getAccuracy() : 10;
            if (d < Math.max(5, acc * 0.6) && (!l.hasSpeed() || l.getSpeed() < 1.5)) return; // står stille / støj
            trip.meters += d;
            if (l.hasSpeed()) trip.maxSpeed = Math.max(trip.maxSpeed, l.getSpeed());
        }
        trip.points.add(new double[]{l.getLatitude(), l.getLongitude()});
        trip.lastUpdate = System.currentTimeMillis();
        last = l;
        long now = System.currentTimeMillis();
        if (now - lastSave > 30_000) { TripStore.saveCurrent(this, trip); lastSave = now; updateNotification(); }
    }

    private void finishTripKeepService() {
        if (trip == null) return;
        TripStore.finish(this, trip);
        trip = null; last = null;
    }

    private void finishTrip() {
        endUpdates();
        finishTripKeepService();
        stopSelfSafely();
    }

    private void stopSelfSafely() {
        running = false; activeAddress = null; activeName = null; activeMeters = 0; activeStart = 0;
        try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE); } catch (Exception ignored) { }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(finalizer);
        if (trip != null) TripStore.saveCurrent(this, trip);
        endUpdates();
        running = false;
        super.onDestroy();
    }
}
