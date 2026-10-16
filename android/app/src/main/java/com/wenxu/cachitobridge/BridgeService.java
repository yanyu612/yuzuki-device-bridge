package com.wenxu.cachitobridge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class BridgeService extends Service implements BleBroadcaster.Listener, LocalBridgeServer.Handler {
    private static final String CHANNEL = "yuzuki_device_bridge";
    private static final int NOTICE = 36;
    private static final String START = "bridge.START", POWER = "bridge.POWER", STOP = "bridge.STOP", SHUTDOWN = "bridge.SHUTDOWN";
    private static volatile boolean running;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CommandWindow window = new CommandWindow();
    private final Runnable deadlineStop = this::stopDevice;
    private BleBroadcaster broadcaster;
    private LocalBridgeServer server;
    private BridgeConfig config;
    private PowerManager.WakeLock wakeLock;
    private volatile int currentPower;
    private volatile boolean shuttingDown;
    private volatile boolean lastError;
    private volatile String lastStatus = "正在启动";
    private long generation;
    private boolean emergencyStopAttempted;

    static boolean isRunning() { return running; }
    static void start(Context context) { context.startForegroundService(new Intent(context, BridgeService.class).setAction(START)); }
    static void setPower(Context context, int power) {
        context.startForegroundService(new Intent(context, BridgeService.class).setAction(POWER).putExtra("power", power));
    }
    static void stopDevice(Context context) {
        if (running) context.startService(new Intent(context, BridgeService.class).setAction(STOP));
    }
    static void shutdown(Context context) {
        if (running) context.startService(new Intent(context, BridgeService.class).setAction(SHUTDOWN));
    }

    @Override public void onCreate() {
        super.onCreate();
        config = new BridgeConfig(this);
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "柚月设备桥", NotificationManager.IMPORTANCE_LOW));
        Notification notification = notification("桥接启动中");
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(NOTICE, notification);
        broadcaster = new BleBroadcaster(this, this);
        wakeLock = getSystemService(PowerManager.class).newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":command-deadline");
        try {
            server = new LocalBridgeServer(this);
            server.start();
            running = true;
            lastStatus = "已开启 · 等待酒馆配对";
            updateNotification();
        } catch (Exception error) {
            lastError = true;
            lastStatus = "端口 8765 被占用，桥接未开启";
            updateNotification();
            stopSelf();
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (POWER.equals(action)) setPower(intent.getIntExtra("power", 0), BridgePolicy.MANUAL_TIMEOUT_MS, true);
        else if (STOP.equals(action)) stopDevice();
        else if (SHUTDOWN.equals(action)) {
            shuttingDown = true;
            if (server != null) server.stop();
            stopDevice();
            // Give the final stop advertisement time to be transmitted before closing the service.
            main.postDelayed(this::stopSelf, 1600);
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        shuttingDown = true;
        main.removeCallbacksAndMessages(null);
        window.clear();
        if (server != null) server.stop();
        if (broadcaster != null) broadcaster.shutdown();
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public String token() { return config.token(); }
    @Override public String allowedOrigin() { return config.origin(); }

    @Override public JSONObject status() {
        try {
            JSONObject profile = new JSONObject().put("id", BridgeConfig.PROFILE_ID)
                    .put("name", BridgeConfig.DEVICE_NAME).put("transport", "ble-advertising")
                    .put("channels", new JSONArray().put("suction"))
                    .put("protocolVerified", true).put("standaloneHardwareVerified", false);
            return new JSONObject().put("ok", true).put("bridgeRunning", running && !shuttingDown)
                    .put("bridgeVersion", "0.4.0-preview").put("apiVersion", 2)
                    .put("bluetoothReady", isBluetoothReady()).put("nativeDeadline", true)
                    .put("profileId", BridgeConfig.PROFILE_ID).put("device", BridgeConfig.DEVICE_NAME)
                    .put("profiles", new JSONArray().put(profile))
                    .put("supportedChannels", new JSONArray().put("suction"))
                    .put("maxPower", config.maxPower()).put("maxTimeoutMs", BridgePolicy.MAX_TIMEOUT_MS)
                    .put("remainingMs", window.remaining(SystemClock.elapsedRealtime()))
                    .put("power", currentPower).put("active", currentPower >= 2)
                    .put("transmitError", lastError).put("message", lastStatus);
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    @Override public synchronized boolean setPower(int power, long timeoutMs, boolean startNew) {
        if (shuttingDown || !running || !isBluetoothReady() || power < 0 || power > 100) return false;
        if (power < 2) { stopDevice(); return true; }
        long deadline;
        try { deadline = window.accept(SystemClock.elapsedRealtime(), timeoutMs, startNew); }
        catch (IllegalArgumentException error) { return false; }
        int clamped = Math.min(power, config.maxPower());
        if (startNew) emergencyStopAttempted = false;
        currentPower = clamped;
        long commandGeneration = ++generation;
        main.post(() -> {
            synchronized (BridgeService.this) {
                if (shuttingDown || commandGeneration != generation) return;
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) { stopDevice(); return; }
                main.removeCallbacks(deadlineStop);
                main.postDelayed(deadlineStop, remaining);
                releaseWakeLock();
                wakeLock.acquire(remaining + 3000);
                broadcaster.send(ProtocolEncoder.power(clamped, ProtocolEncoder.createCommandId(), config.controllerId()));
            }
        });
        return true;
    }

    @Override public synchronized void stopDevice() {
        long stopGeneration = ++generation;
        currentPower = 0;
        window.clear();
        main.removeCallbacks(deadlineStop);
        main.post(() -> {
            synchronized (BridgeService.this) {
                if (stopGeneration != generation) return;
                boolean ready = isBluetoothReady();
                if (ready) broadcaster.send(ProtocolEncoder.stop(ProtocolEncoder.createCommandId(), config.controllerId()));
                releaseWakeLock();
                wakeLock.acquire(2000);
                lastStatus = ready ? "停止指令已提交" : "蓝牙未就绪，停止帧未能发送";
                if (!ready) lastError = true;
                updateNotification();
            }
        });
    }

    @Override public void onServerError(String message) {
        lastError = true;
        lastStatus = message;
        main.post(this::updateNotification);
    }

    @Override public void onStatus(String message, boolean error) {
        lastStatus = message;
        lastError = error;
        if (error) {
            // Invalidate pending pattern continuations after a transmission error.
            synchronized (this) {
                generation++;
                currentPower = 0;
                window.clear();
                main.removeCallbacks(deadlineStop);
                releaseWakeLock();
                if (!emergencyStopAttempted && isBluetoothReady()) {
                    emergencyStopAttempted = true;
                    main.post(this::stopDevice);
                }
            }
        }
        updateNotification();
    }

    @SuppressLint("MissingPermission")
    private boolean isBluetoothReady() {
        if (Build.VERSION.SDK_INT >= 31
                && (checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)) return false;
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        return adapter != null && adapter.isEnabled() && adapter.isMultipleAdvertisementSupported();
    }

    private void releaseWakeLock() { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); }

    private Notification notification(String text) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, BridgeService.class).setAction(STOP), flags);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_launcher_bridge)
                .setContentTitle("柚月设备桥").setContentText(text).setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "立即停止", stop).build())
                .setOngoing(true).setCategory(Notification.CATEGORY_SERVICE).build();
    }
    private void updateNotification() {
        getSystemService(NotificationManager.class).notify(NOTICE, notification(lastStatus));
    }
}
