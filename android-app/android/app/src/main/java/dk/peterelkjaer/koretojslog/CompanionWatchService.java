package dk.peterelkjaer.koretojslog;

import android.companion.AssociationInfo;
import android.companion.CompanionDeviceManager;
import android.companion.CompanionDeviceService;
import android.companion.DevicePresenceEvent;
import android.net.MacAddress;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;

import java.util.List;

/**
 * Androids "companion device"-tjeneste: systemet vækker denne tjeneste, når en tilknyttet
 * Bluetooth-enhed (f.eks. motorcyklens skærm) forbinder eller afbryder – også når appen er lukket.
 */
@RequiresApi(31)
public class CompanionWatchService extends CompanionDeviceService {

    private void appeared(String address) {
        if (address == null) return;
        TripStore.logEvent(this, "Forbundet: " + TripStore.watchedName(this, address));
        if (TripStore.isWatched(this, address)) TripService.send(this, TripService.ACTION_START, address, TripStore.watchedName(this, address));
    }

    private void disappeared(String address) {
        if (address == null) return;
        TripStore.logEvent(this, "Afbrudt: " + TripStore.watchedName(this, address));
        if (TripStore.isWatched(this, address)) TripService.send(this, TripService.ACTION_STOP, address, null);
    }

    // Android 12
    @Override public void onDeviceAppeared(@NonNull String address) { appeared(address); }
    @Override public void onDeviceDisappeared(@NonNull String address) { disappeared(address); }

    // Android 13–15
    @RequiresApi(33)
    @Override public void onDeviceAppeared(@NonNull AssociationInfo info) { appeared(mac(info)); }
    @RequiresApi(33)
    @Override public void onDeviceDisappeared(@NonNull AssociationInfo info) { disappeared(mac(info)); }

    // Android 16+
    @RequiresApi(36)
    @Override
    public void onDevicePresenceEvent(@NonNull DevicePresenceEvent event) {
        String address = macForId(event.getAssociationId());
        switch (event.getEvent()) {
            case DevicePresenceEvent.EVENT_BT_CONNECTED:
            case DevicePresenceEvent.EVENT_BLE_APPEARED:
                appeared(address); break;
            case DevicePresenceEvent.EVENT_BT_DISCONNECTED:
            case DevicePresenceEvent.EVENT_BLE_DISAPPEARED:
                disappeared(address); break;
            default: break;
        }
    }

    @RequiresApi(33)
    static String mac(AssociationInfo info) {
        MacAddress m = info.getDeviceMacAddress();
        return m == null ? null : TripStore.norm(m.toString());
    }

    @RequiresApi(33)
    private String macForId(int id) {
        CompanionDeviceManager cdm = getSystemService(CompanionDeviceManager.class);
        List<AssociationInfo> list = cdm.getMyAssociations();
        for (AssociationInfo a : list) if (a.getId() == id) return mac(a);
        return null;
    }
}
