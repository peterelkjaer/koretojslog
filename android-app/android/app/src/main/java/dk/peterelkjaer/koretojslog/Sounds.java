package dk.peterelkjaer.koretojslog;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

/**
 * Korte lyde til køreskærmen. De genereres i koden og afspilles som navigationslyd,
 * så de kommer ud i bilens/headsettets højttaler via Android Auto og dæmper musikken kortvarigt.
 */
final class Sounds {
    private Sounds() { }
    private static final int RATE = 22050;
    private static short[] ding, bip, alarm;
    private static final Handler h = new Handler(Looper.getMainLooper());

    /** Klokke-"ding": fartgrænse overskredet / gul serviceadvarsel. */
    static void ding(Context c) { if (ding == null) ding = bell(); play(c, ding); }
    /** Kort "bip": ny fartgrænse forude. */
    static void bip(Context c) { if (bip == null) bip = tone(1000, 0.16, 1); play(c, bip); }
    /** Insisterende "biiip": rød serviceadvarsel. */
    static void alarm(Context c) { if (alarm == null) alarm = alarmTone(); play(c, alarm); }

    private static short[] bell() {
        int n = (int) (RATE * 0.9); short[] s = new short[n];
        for (int i = 0; i < n; i++) {
            double t = i / (double) RATE;
            double env = Math.min(1, t / 0.004) * Math.exp(-t * 5.5);
            double v = Math.sin(2 * Math.PI * 1568 * t) + 0.45 * Math.sin(2 * Math.PI * 3136 * t) * Math.exp(-t * 4) + 0.2 * Math.sin(2 * Math.PI * 4704 * t) * Math.exp(-t * 8);
            s[i] = (short) (v / 1.65 * env * 30000);
        }
        return s;
    }

    private static short[] tone(double f, double dur, double vol) {
        int n = (int) (RATE * dur); short[] s = new short[n];
        for (int i = 0; i < n; i++) {
            double t = i / (double) RATE;
            double env = Math.min(1, Math.min(t / 0.008, (dur - t) / 0.02));
            s[i] = (short) (Math.sin(2 * Math.PI * f * t) * env * vol * 28000);
        }
        return s;
    }

    private static short[] alarmTone() {
        double beep = 0.42, gap = 0.14; int reps = 3;
        int n = (int) (RATE * (beep + gap) * reps); short[] s = new short[n];
        for (int i = 0; i < n; i++) {
            double t = i / (double) RATE, tt = t % (beep + gap);
            if (tt > beep) continue;
            double env = Math.min(1, Math.min(tt / 0.008, (beep - tt) / 0.02));
            double v = Math.sin(2 * Math.PI * 880 * t) + 0.3 * Math.sin(2 * Math.PI * 2640 * t);
            s[i] = (short) (v / 1.3 * env * 30000);
        }
        return s;
    }

    private static void play(Context ctx, short[] pcm) {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
            Object focus = null;
            if (Build.VERSION.SDK_INT >= 26) {
                AudioFocusRequest fr = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build();
                am.requestAudioFocus(fr); focus = fr;
            } else {
                //noinspection deprecation
                am.requestAudioFocus(null, AudioManager.STREAM_NOTIFICATION, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
            AudioTrack tr = new AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(pcm.length * 2)
                .setTransferMode(AudioTrack.MODE_STATIC).build();
            tr.write(pcm, 0, pcm.length);
            tr.play();
            final Object f = focus;
            h.postDelayed(() -> {
                try { tr.stop(); } catch (Exception ignored) { }
                tr.release();
                if (Build.VERSION.SDK_INT >= 26 && f != null) am.abandonAudioFocusRequest((AudioFocusRequest) f);
                else //noinspection deprecation
                    am.abandonAudioFocus(null);
            }, pcm.length * 1000L / RATE + 250);
        } catch (Exception e) {
            TripStore.logEvent(ctx, "Lyd kunne ikke afspilles: " + e.getClass().getSimpleName());
        }
    }
}
