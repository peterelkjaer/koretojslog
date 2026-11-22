package dk.peterelkjaer.koretojslog;

import android.app.Activity;
import android.content.Context;
import android.content.IntentSender;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.List;

/**
 * Køretøjslogs egen bro mellem web-appen og Android:
 *  - authorize: henter et adgangstoken til Google Drive via Google Play-tjenester
 *    (første gang vises Googles samtykke; derefter sker det lydløst).
 *  - print: udskriver/gemmer den viste side som PDF via Androids udskriftsdialog.
 */
@CapacitorPlugin(name = "NativeHelper")
public class NativeHelperPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> authLauncher;
    private PluginCall pendingAuthCall;

    @Override
    public void load() {
        // Skal registreres mens aktiviteten oprettes
        authLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::authResult);
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
            .addOnFailureListener(e -> call.reject("Google-login fejlede: " + e.getMessage()));
    }

    private void authResult(ActivityResult activityResult) {
        PluginCall call = pendingAuthCall;
        pendingAuthCall = null;
        if (call == null) return;
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                .getAuthorizationResultFromIntent(activityResult.getData());
            resolveToken(call, result);
        } catch (ApiException e) {
            call.reject("Login blev afbrudt (" + e.getStatusCode() + ")", "CANCELLED");
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
        String name = call.getString("name", "Køretøjslog");
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
}
