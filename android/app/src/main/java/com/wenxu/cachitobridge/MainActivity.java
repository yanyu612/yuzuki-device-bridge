package com.wenxu.cachitobridge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Intent;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.widget.Button;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.EditText;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int REQUEST_BLUETOOTH_PERMISSIONS = 1001;
    private static final int REQUEST_ENABLE_BLUETOOTH = 1002;
    private static final long LIVE_UPDATE_INTERVAL_MS = 120L;

    private TextView statusText;
    private TextView powerText;
    private TextView logText;
    private SeekBar powerSeekBar;
    private Button stopButton;
    private Button bridgeButton;
    private BridgeConfig config;
    private EditText originInput;
    private EditText maxPowerInput;
    private final Handler sliderHandler = new Handler(Looper.getMainLooper());
    private long lastLiveUpdateAt;
    private final Runnable sendTrailingSliderValue = () -> sendSelectedValue(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusText = findViewById(R.id.statusText);
        powerText = findViewById(R.id.powerText);
        logText = findViewById(R.id.logText);
        powerSeekBar = findViewById(R.id.powerSeekBar);
        stopButton = findViewById(R.id.stopButton);
        bridgeButton = findViewById(R.id.bridgeButton);
        Button clearLogButton = findViewById(R.id.clearLogButton);

        config = new BridgeConfig(this);
        originInput = findViewById(R.id.originInput);
        maxPowerInput = findViewById(R.id.maxPowerInput);
        originInput.setText(config.origin());
        maxPowerInput.setText(String.valueOf(config.maxPower()));
        powerSeekBar.setMax(config.maxPower());
        findViewById(R.id.saveConfigButton).setOnClickListener(view -> {
            try {
                int maxPower = Integer.parseInt(maxPowerInput.getText().toString());
                config.save(originInput.getText().toString(), maxPower);
                BridgeService.stopDevice(this);
                originInput.setText(config.origin());
                powerSeekBar.setProgress(0);
                powerSeekBar.setMax(maxPower);
                appendLog("酒馆地址与强度上限已保存");
            } catch (IllegalArgumentException error) {
                Toast.makeText(this, "请检查酒馆地址和 2–100 的强度上限", Toast.LENGTH_LONG).show();
            }
        });
        findViewById(R.id.copyPairingButton).setOnClickListener(view -> {
            getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("设备桥配对密钥", config.token()));
            Toast.makeText(this, "已复制，请粘贴到酒馆插件的配对密钥栏", Toast.LENGTH_LONG).show();
        });
        findViewById(R.id.rotatePairingButton).setOnClickListener(view -> {
            BridgeService.stopDevice(this);
            config.rotateToken();
            Toast.makeText(this, "旧密钥已失效，请重新复制并配对", Toast.LENGTH_LONG).show();
        });

        powerSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                updatePowerLabel();
                if (fromUser) {
                    scheduleLiveUpdate();
                }
            }

            @Override public void onStartTrackingTouch(SeekBar seekBar) { }
            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                sliderHandler.removeCallbacks(sendTrailingSliderValue);
                sendSelectedValue(true);
            }
        });

        stopButton.setOnClickListener(view -> sendStop("手动停止"));
        bridgeButton.setOnClickListener(view -> toggleBridge());
        clearLogButton.setOnClickListener(view -> logText.setText(""));

        appendLog("仅支持 Cachito ID 36；其他型号尚未适配");
        ensureBluetoothReady();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateReadyState();
    }

    @Override
    protected void onPause() {
        super.onPause();
        sliderHandler.removeCallbacks(sendTrailingSliderValue);
        if (!isChangingConfigurations() && hasBluetoothPermissions()) {
            powerSeekBar.setProgress(0);
            sendStop("离开页面自动停止");
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
    }

    private int selectedPower() {
        return powerSeekBar.getProgress();
    }

    private void updatePowerLabel() {
        int power = selectedPower();
        powerText.setText(power < 2
                ? getString(R.string.power_paused)
                : getString(R.string.power_label, power));
    }

    private void scheduleLiveUpdate() {
        if (!isControlReady()) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        long elapsed = now - lastLiveUpdateAt;
        sliderHandler.removeCallbacks(sendTrailingSliderValue);
        if (elapsed >= LIVE_UPDATE_INTERVAL_MS) {
            sendSelectedValue(false);
        } else {
            sliderHandler.postDelayed(sendTrailingSliderValue, LIVE_UPDATE_INTERVAL_MS - elapsed);
        }
    }

    @SuppressLint("MissingPermission")
    private void ensureBluetoothReady() {
        if (!hasBluetoothPermissions()) {
            if (Build.VERSION.SDK_INT >= 33) {
                requestPermissions(new String[] {
                        Manifest.permission.BLUETOOTH_ADVERTISE,
                        Manifest.permission.BLUETOOTH_CONNECT,
                        Manifest.permission.POST_NOTIFICATIONS
                }, REQUEST_BLUETOOTH_PERMISSIONS);
            } else if (Build.VERSION.SDK_INT >= 31) {
                requestPermissions(new String[] {
                        Manifest.permission.BLUETOOTH_ADVERTISE,
                        Manifest.permission.BLUETOOTH_CONNECT
                }, REQUEST_BLUETOOTH_PERMISSIONS);
            }
            return;
        }
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter != null && !adapter.isEnabled()) {
            startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE_BLUETOOTH);
            return;
        }
        updateReadyState();
    }

    private void updateReadyState() {
        boolean ready = isControlReady();
        stopButton.setEnabled(ready);
        powerSeekBar.setEnabled(ready);
        bridgeButton.setEnabled(ready);
        bridgeButton.setText(BridgeService.isRunning()
                ? R.string.stop_bridge : R.string.start_bridge);
        statusText.setText(ready
                ? (BridgeService.isRunning()
                    ? "酒馆桥接已开启 · 回到酒馆填写配对密钥"
                    : "蓝牙广播就绪 · 请开启酒馆桥接")
                : "等待蓝牙与附近设备权限");
    }

    private boolean isControlReady() {
        if (!hasBluetoothPermissions()) {
            return false;
        }
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        return adapter != null && adapter.isEnabled() && adapter.isMultipleAdvertisementSupported();
    }

    private void toggleBridge() {
        if (BridgeService.isRunning()) {
            BridgeService.shutdown(this);
            appendLog("酒馆桥接已关闭");
        } else {
            BridgeService.start(this);
            appendLog("酒馆桥接已开启 · 仅限本机访问");
        }
        bridgeButton.postDelayed(this::updateReadyState, 250L);
    }

    private void ensureBridgeRunning() {
        if (!BridgeService.isRunning()) {
            BridgeService.start(this);
        }
    }

    private void sendSelectedValue(boolean log) {
        if (!isControlReady()) {
            ensureBluetoothReady();
            return;
        }
        int power = selectedPower();
        lastLiveUpdateAt = SystemClock.elapsedRealtime();
        ensureBridgeRunning();
        if (power < 2) {
            sendStop(log ? "滑至暂停" : null);
            return;
        }
        if (log) {
            appendLog("请求强度 " + power + " · 最多 30 秒自动停止");
        }
        BridgeService.setPower(this, power);
    }

    private void sendStop(String reason) {
        if (reason != null) {
            appendLog(reason);
        }
        if (BridgeService.isRunning()) {
            BridgeService.stopDevice(this);
        }
    }

    private boolean hasBluetoothPermissions() {
        if (Build.VERSION.SDK_INT < 31) {
            return true;
        }
        return checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void appendLog(String text) {
        String time = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());
        CharSequence current = logText.getText();
        String prefix = current.length() == 0 ? "" : current + "\n";
        logText.setText(getString(R.string.log_entry_format, prefix + time, text));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_BLUETOOTH_PERMISSIONS) {
            if (hasBluetoothPermissions()) {
                appendLog("附近设备权限已允许");
                ensureBluetoothReady();
            } else {
                appendLog("附近设备权限被拒绝");
                updateReadyState();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_ENABLE_BLUETOOTH) {
            updateReadyState();
        }
    }
}
