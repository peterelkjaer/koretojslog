package dk.peterelkjaer.koretojslog;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;

/** Indgangen til Android Auto. Appen er kun til eget brug, så alle Android Auto-værter accepteres. */
public class KlCarAppService extends CarAppService {
    @NonNull @Override
    public HostValidator createHostValidator() { return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR; }

    @NonNull @Override
    public Session onCreateSession() {
        return new Session() {
            @NonNull @Override
            public Screen onCreateScreen(@NonNull Intent intent) { return new DashScreen(getCarContext()); }
        };
    }
}
