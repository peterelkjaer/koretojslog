package dk.peterelkjaer.koretojslog;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeHelperPlugin.class);
        super.onCreate(savedInstanceState);
        handleTripLink(getIntent(), true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleTripLink(intent, false);
    }

    /** koretojslog://trip/start?device=AA:BB:CC:DD:EE:FF  og  koretojslog://trip/stop (f.eks. fra Tasker) */
    private void handleTripLink(Intent intent, boolean fresh) {
        Uri u = intent != null ? intent.getData() : null;
        if (u == null || !"koretojslog".equals(u.getScheme()) || !"trip".equals(u.getHost())) return;
        String path = u.getPath() == null ? "" : u.getPath();
        String device = u.getQueryParameter("device");
        if (path.startsWith("/start") && device != null) {
            TripService.send(this, TripService.ACTION_START, device, TripStore.watchedName(this, device));
        } else if (path.startsWith("/stop")) {
            TripService.send(this, TripService.ACTION_STOP, device, null);
        }
        if (fresh) moveTaskToBack(true);
    }
}
