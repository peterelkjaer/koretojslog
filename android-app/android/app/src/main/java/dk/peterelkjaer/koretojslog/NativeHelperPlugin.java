package dk.peterelkjaer.koretojslog;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.companion.AssociationInfo;
import android.companion.AssociationRequest;
import android.companion.BluetoothDeviceFilter;
import android.companion.CompanionDeviceManager;
import android.companion.ObservingDevicePresenceRequest;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Køretøjslogs egen bro mellem web-appen og Android:
 *  - authorize: henter et adgangstoken til Google Drive via Google Play-tjenester
 *    (første gang vises Googles samtykke; derefter sker det lydløst).
 *  - print: udskriver/gemmer den viste side som PDF via Androids udskriftsdialog.
 */
@CapacitorPlugin(name = "NativeHelper", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    @Permission(alias = "backgroundLocation", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
    @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class NativeHelperPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> authLauncher;
    private PluginCall pendingAuthCall;
    private ActivityResultLauncher<IntentSenderRequest> cdmLauncher;
    private PluginCall pendingCdmCall;
    private String pendingCdmAddress, pendingCdmName;

    @Override
    public void load() {
        // Skal registreres mens aktiviteten oprettes
        authLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::authResult);
        cdmLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), r -> {
                // Selve tilknytningen meldes i onAssociationCreated; her fanges kun "annuller"
                if (r.getResultCode() != Activity.RESULT_OK && pendingCdmCall != null) {
                    PluginCall c = pendingCdmCall; pendingCdmCall = null;
                    c.reject("Tilknytning blev annulleret", "CANCELLED");
                }
            });
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        JSArray scopesArr = call.getArray("scopes");
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", true));
        List<Scope> scopes = new ArrayList<>();
        try {
            for (Object s : scopesArr.toList()) scopes.add(new Scope(s.toString()));
        } catch (Exception e) {
            call.reject("Ugyldige scopes");
            return;
        }
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Activity activity = getActivity();
        Identity.getAuthorizationClient(activity)
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (result.hasResolution()) {
                    if (!interactive) {
                        call.reject("Login kræves", "NEED_INTERACTION");
                        return;
                    }
                    try {
                        IntentSender sender = result.getPendingIntent().getIntentSender();
                        pendingAuthCall = call;
                        authLauncher.launch(new IntentSenderRequest.Builder(sender).build());
                    } catch (Exception e) {
                        call.reject("Kunne ikke vise Google-login: " + e.getMessage());
                    }
                } else {
                    resolveToken(call, result);
                }
            })
            .addOnFailureListener(e -> { TripStore.logEvent(getContext(), "Google-login fejlede: " + e.getMessage()); call.reject("Google-login fejlede: " + e.getMessage()); });
    }

    private void authResult(ActivityResult activityResult) {
        PluginCall call = pendingAuthCall;
        pendingAuthCall = null;
        if (call == null) return;
        TripStore.logEvent(getContext(), "Google-login svar: resultCode=" + activityResult.getResultCode() + (activityResult.getData() == null ? ", ingen data" : ""));
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                .getAuthorizationResultFromIntent(activityResult.getData());
            resolveToken(call, result);
        } catch (ApiException e) {
            String msg = "Login blev afbrudt (kode " + e.getStatusCode() + ", svar " + activityResult.getResultCode() + ")"
                + (e.getMessage() != null ? ": " + e.getMessage() : "");
            TripStore.logEvent(getContext(), msg);
            call.reject(msg, "CANCELLED");
        } catch (Exception e) {
            String msg = "Login fejlede: " + e.getClass().getSimpleName() + " " + e.getMessage();
            TripStore.logEvent(getContext(), msg);
            call.reject(msg);
        }
    }

    private void resolveToken(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) {
            call.reject("Google returnerede intet adgangstoken");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", token);
        call.resolve(ret);
    }

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "Motorist");
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
                pm.print(name, adapter, new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Exception e) {
                call.reject("Udskrivning fejlede: " + e.getMessage());
            }
        });
    }

    // ===================== Turlogning =====================

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject statusObj() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        o.put("backgroundLocation", Build.VERSION.SDK_INT < 29 || granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        o.put("bluetooth", Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT));
        o.put("notifications", Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS));
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        o.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        JSArray assoc = new JSArray();
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                CompanionDeviceManager cdm = c.getSystemService(CompanionDeviceManager.class);
                for (AssociationInfo a : cdm.getMyAssociations()) { String m = CompanionWatchService.mac(a); if (m != null) assoc.put(m); }
            }
        } catch (Exception ignored) { }
        o.put("associations", assoc);
        o.put("tripActive", TripService.running);
        o.put("activeAddress", TripService.activeAddress);
        o.put("activeName", TripService.activeName);
        o.put("activeKm", TripService.activeMeters / 1000.0);
        o.put("activeStart", TripService.activeStart);
        o.put("log", TripStore.prefs(c).getString("log", ""));
        return o;
    }

    @PluginMethod
    public void autoLogStatus(PluginCall call) { call.resolve(statusObj()); }

    /** Beder om én tilladelse ad gangen: which = location | backgroundLocation | bluetooth | notifications */
    @PluginMethod
    public void requestPerm(PluginCall call) {
        String which = call.getString("which", "location");
        if (("bluetooth".equals(which) && Build.VERSION.SDK_INT < 31) || ("notifications".equals(which) && Build.VERSION.SDK_INT < 33)
            || ("backgroundLocation".equals(which) && Build.VERSION.SDK_INT < 29)) { call.resolve(statusObj()); return; }
        if (getPermissionState(which) == PermissionState.GRANTED) { call.resolve(statusObj()); return; }
        requestPermissionForAlias(which, call, "permCallback");
    }

    @PermissionCallback
    private void permCallback(PluginCall call) { call.resolve(statusObj()); }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @SuppressLint("BatteryLife")
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            getActivity().startActivity(i);
        }
        call.resolve();
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void listBonded(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && !granted(Manifest.permission.BLUETOOTH_CONNECT)) { call.reject("Mangler Bluetooth-tilladelse", "NO_PERMISSION"); return; }
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter ad = bm != null ? bm.getAdapter() : null;
        JSArray arr = new JSArray();
        if (ad != null) {
            Set<BluetoothDevice> devs = ad.getBondedDevices();
            if (devs != null) for (BluetoothDevice d : devs) {
                JSObject o = new JSObject();
                o.put("name", d.getName() != null ? d.getName() : d.getAddress());
                o.put("address", TripStore.norm(d.getAddress()));
                arr.put(o);
            }
        }
        JSObject ret = new JSObject(); ret.put("devices", arr); call.resolve(ret);
    }

    /** Tilknytter en Bluetooth-enhed (companion device) og begynder at overvåge den. */
    @PluginMethod
    public void enableAutoLog(PluginCall call) {
        String address = TripStore.norm(call.getString("address"));
        String name = call.getString("name", address);
        if (address.isEmpty()) { call.reject("Ingen enhed valgt"); return; }
        TripStore.watch(getContext(), address, name);
        if (Build.VERSION.SDK_INT < 33) { // ældre Android: kun Bluetooth-lytteren
            JSObject r = statusObj(); r.put("mode", "receiver"); call.resolve(r); return;
        }
        CompanionDeviceManager cdm = getContext().getSystemService(CompanionDeviceManager.class);
        for (AssociationInfo a : cdm.getMyAssociations()) {
            if (address.equals(CompanionWatchService.mac(a))) { observe(cdm, a, address); JSObject r = statusObj(); r.put("mode", "companion"); call.resolve(r); return; }
        }
        BluetoothDeviceFilter filter = new BluetoothDeviceFilter.Builder()
            .setAddress(address).setNamePattern(Pattern.compile(".*")).build();
        AssociationRequest req = new AssociationRequest.Builder().addDeviceFilter(filter).setSingleDevice(true).build();
        pendingCdmCall = call; pendingCdmAddress = address; pendingCdmName = name;
        cdm.associate(req, ContextCompat.getMainExecutor(getContext()), new CompanionDeviceManager.Callback() {
            @Override public void onAssociationPending(IntentSender sender) {
                try { cdmLauncher.launch(new IntentSenderRequest.Builder(sender).build()); }
                catch (Exception e) { finishCdm(null, "Kunne ikke vise tilknytning: " + e.getMessage()); }
            }
            @Override public void onAssociationCreated(AssociationInfo info) {
                observe(cdm, info, pendingCdmAddress);
                finishCdm(info, null);
            }
            @Override public void onFailure(CharSequence error) { finishCdm(null, "Tilknytning fejlede: " + error); }
        });
    }

    private void finishCdm(AssociationInfo info, String error) {
        PluginCall c = pendingCdmCall; pendingCdmCall = null;
        if (c == null) return;
        if (error != null) { c.reject(error); return; }
        JSObject r = statusObj(); r.put("mode", "companion"); c.resolve(r);
    }

    @SuppressLint("MissingPermission")
    private void observe(CompanionDeviceManager cdm, AssociationInfo a, String address) {
        try {
            if (Build.VERSION.SDK_INT >= 36) {
                cdm.startObservingDevicePresence(new ObservingDevicePresenceRequest.Builder().setAssociationId(a.getId()).build());
            } else {
                cdm.startObservingDevicePresence(address);
            }
            TripStore.logEvent(getContext(), "Overvåger " + TripStore.watchedName(getContext(), address));
        } catch (Exception e) {
            TripStore.logEvent(getContext(), "Overvågning fejlede: " + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void disableAutoLog(PluginCall call) {
        String address = TripStore.norm(call.getString("address"));
        TripStore.unwatch(getContext(), address);
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                CompanionDeviceManager cdm = getContext().getSystemService(CompanionDeviceManager.class);
                for (AssociationInfo a : cdm.getMyAssociations()) if (address.equals(CompanionWatchService.mac(a))) {
                    try {
                        if (Build.VERSION.SDK_INT >= 36) cdm.stopObservingDevicePresence(new ObservingDevicePresenceRequest.Builder().setAssociationId(a.getId()).build());
                        else cdm.stopObservingDevicePresence(address);
                    } catch (Exception ignored) { }
                    cdm.disassociate(a.getId());
                }
            } catch (Exception ignored) { }
        }
        call.resolve(statusObj());
    }

    @PluginMethod
    public void startTrip(PluginCall call) {
        String address = call.getString("address", "MANUAL");
        String name = call.getString("name", "Manuel tur");
        TripService.send(getContext(), TripService.ACTION_START, address, name);
        call.resolve();
    }

    @PluginMethod
    public void stopTrip(PluginCall call) {
        TripService.send(getContext(), TripService.ACTION_STOP_NOW, null, null);
        call.resolve();
    }

    /** Afsluttede ture, der venter på at blive hentet. */
    @PluginMethod
    public void getTrips(PluginCall call) {
        Context c = getContext();
        // En tur, der hænger (f.eks. hvis telefonen slukkede), afsluttes efter 15 min. uden opdateringer
        if (!TripService.running) {
            TripStore.Trip cur = TripStore.loadCurrent(c);
            if (cur != null && System.currentTimeMillis() - cur.lastUpdate > 15 * 60_000) TripStore.finish(c, cur);
        }
        JSONArray arr = TripStore.listDone(c);
        JSObject ret = new JSObject();
        try { ret.put("trips", new JSArray(arr.toString())); } catch (Exception e) { ret.put("trips", new JSArray()); }
        call.resolve(ret);
    }

    @PluginMethod
    public void ackTrips(PluginCall call) {
        List<String> ids = new ArrayList<>();
        try { for (Object o : call.getArray("ids").toList()) ids.add(o.toString()); } catch (Exception ignored) { }
        TripStore.ack(getContext(), ids);
        call.resolve();
    }

    /** Øjebliksbillede af tallene til Android Auto-skærmen (sendes fra web-delen). */
    @PluginMethod
    public void setCarData(PluginCall call) {
        CarData.save(getContext(), call.getString("json", "{}"));
        call.resolve();
    }

    /** Gemte fartgrænse-felter: antal og størrelse, eller ryd dem (clear: true). */
    @PluginMethod
    public void speedCache(PluginCall call) {
        SpeedLimits sl = SpeedLimits.get(getContext());
        if (Boolean.TRUE.equals(call.getBoolean("clear", false))) sl.clearDisk();
        long[] info = sl.diskInfo();
        JSObject r = new JSObject(); r.put("tiles", info[0]); r.put("bytes", info[1]);
        call.resolve(r);
    }
}
