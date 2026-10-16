package com.wenxu.cachitobridge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertisingSet;
import android.bluetooth.le.AdvertisingSetCallback;
import android.bluetooth.le.AdvertisingSetParameters;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

/** Serial, latest-value advertising queue. Late callbacks cannot revive a closed broadcaster. */
public final class BleBroadcaster {
    public interface Listener { void onStatus(String text, boolean error); }
    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothAdapter adapter;
    private AdvertisingSet currentSet;
    private AdvertisingSetCallback callback;
    private ProtocolEncoder.EncodedCommand currentCommand, queued;
    private boolean busy;
    private long epoch;
    private final Runnable stopAfterCommand = this::shutdown;

    public BleBroadcaster(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        adapter = manager == null ? null : manager.getAdapter();
    }
    @SuppressLint("MissingPermission")
    public boolean isReady() {
        return hasPermissions() && adapter != null && adapter.isEnabled()
                && adapter.isMultipleAdvertisementSupported();
    }

    @SuppressLint("MissingPermission")
    public void send(ProtocolEncoder.EncodedCommand command) {
        if (!isReady() || adapter.getBluetoothLeAdvertiser() == null) {
            listener.onStatus("蓝牙未就绪或缺少附近设备权限", true); return;
        }
        main.removeCallbacks(stopAfterCommand);
        if (busy) { queued = command; return; }
        currentCommand = command;
        try {
            if (currentSet != null) {
                busy = true;
                currentSet.setAdvertisingData(data(command));
                return;
            }
            busy = true;
            final long cycle = ++epoch;
            callback = new AdvertisingSetCallback() {
                @Override public void onAdvertisingSetStarted(AdvertisingSet set, int tx, int status) {
                    if (cycle != epoch) { stopSafely(this); return; }
                    busy = false;
                    if (status != ADVERTISE_SUCCESS || set == null) {
                        currentSet = null;
                        queued = null;
                        listener.onStatus("广播启动失败，错误码 " + status, true);
                        return;
                    }
                    currentSet = set;
                    listener.onStatus("蓝牙广播已发送（无设备回执）", false);
                    complete();
                }
                @Override public void onAdvertisingDataSet(AdvertisingSet set, int status) {
                    if (cycle != epoch) return;
                    busy = false;
                    if (status != ADVERTISE_SUCCESS) {
                        queued = null;
                        listener.onStatus("广播更新失败，错误码 " + status, true);
                        return;
                    }
                    listener.onStatus("蓝牙指令已发送（无设备回执）", false);
                    complete();
                }
                @Override public void onAdvertisingSetStopped(AdvertisingSet set) {
                    if (cycle == epoch && set == currentSet) currentSet = null;
                }
            };
            adapter.getBluetoothLeAdvertiser().startAdvertisingSet(new AdvertisingSetParameters.Builder()
                    .setLegacyMode(true).setInterval(160)
                    .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH)
                    .setConnectable(false).setScannable(false).build(),
                    data(command), null, null, null, 0, 0, callback);
        } catch (RuntimeException error) {
            busy = false;
            queued = null;
            listener.onStatus("系统拒绝蓝牙广播，请检查权限和蓝牙状态", true);
        }
    }

    private void complete() {
        if (queued != null) {
            ProtocolEncoder.EncodedCommand next = queued;
            queued = null;
            send(next);
        } else if (currentCommand != null && currentCommand.stop) {
            main.postDelayed(stopAfterCommand, 1200);
        }
    }

    @SuppressLint("MissingPermission")
    private void stopSafely(AdvertisingSetCallback value) {
        try {
            if (adapter != null && adapter.getBluetoothLeAdvertiser() != null && value != null)
                adapter.getBluetoothLeAdvertiser().stopAdvertisingSet(value);
        } catch (RuntimeException ignored) { }
    }

    public void shutdown() {
        main.removeCallbacks(stopAfterCommand);
        epoch++;
        stopSafely(callback);
        callback = null;
        currentSet = null;
        currentCommand = queued = null;
        busy = false;
    }
    private AdvertiseData data(ProtocolEncoder.EncodedCommand command) {
        return new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(command.serviceUuid))
                .setIncludeDeviceName(false).build();
    }
    private boolean hasPermissions() {
        return Build.VERSION.SDK_INT < 31
                || (context.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED);
    }
}
