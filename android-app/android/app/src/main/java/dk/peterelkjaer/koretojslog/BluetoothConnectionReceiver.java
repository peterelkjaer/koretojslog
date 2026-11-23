package dk.peterelkjaer.koretojslog;

import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Reserve-løsning ved siden af companion-tjenesten: lytter på Bluetooth-forbindelser direkte.
 * Starter/stopper turlogning for enheder, der er valgt i appen.
 */
public class BluetoothConnectionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
        if (device == null) return;
        String address = TripStore.norm(device.getAddress());
        if (!TripStore.isWatched(context, address)) return;
        if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(intent.getAction())) {
            TripService.send(context, TripService.ACTION_START, address, TripStore.watchedName(context, address));
        } else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(intent.getAction())) {
            TripService.send(context, TripService.ACTION_STOP, address, null);
        }
    }
}
