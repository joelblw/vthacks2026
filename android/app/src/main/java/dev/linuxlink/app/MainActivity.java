package dev.linuxlink.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.*;

public class MainActivity extends Activity {
  static final UUID SERVICE = UUID.fromString("7b910001-6b21-4c45-8c62-55b14b3af100"), RX = UUID.fromString("7b910002-6b21-4c45-8c62-55b14b3af100"), TX = UUID.fromString("7b910003-6b21-4c45-8c62-55b14b3af100"), CCC = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
  WebView web; BluetoothAdapter adapter; BluetoothLeScanner scanner; BluetoothGatt gatt; BluetoothGattCharacteristic rx;
  final Queue<byte[]> writes = new ArrayDeque<>(); final Handler handler = new Handler(); boolean scanning, writing;

  @Override @SuppressLint("SetJavaScriptEnabled") public void onCreate(Bundle state) {
    super.onCreate(state); adapter = ((BluetoothManager)getSystemService(BLUETOOTH_SERVICE)).getAdapter();
    web = new WebView(this); WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
    web.setWebViewClient(new WebViewClient()); web.addJavascriptInterface(new Bridge(), "AndroidBLE"); setContentView(web); web.loadUrl("http://127.0.0.1:8000/");
  }
  void js(String source) { runOnUiThread(() -> web.evaluateJavascript(source, null)); }
  boolean allowed() { return android.os.Build.VERSION.SDK_INT < 31 || checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED; }
  void start() {
    if (!allowed()) { requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}, 1); js("window.__linuxLinkNativeError('Allow Nearby devices, then tap Connect LinuxLink again.')"); return; }
    if (adapter == null || !adapter.isEnabled()) { js("window.__linuxLinkNativeError('Turn on Bluetooth, then try again.')"); return; }
    scanner = adapter.getBluetoothLeScanner(); if (scanner == null) { js("window.__linuxLinkNativeError('Bluetooth scanning is unavailable.')"); return; }
    scanning = true; ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new android.os.ParcelUuid(SERVICE)).build();
    scanner.startScan(Collections.singletonList(filter), new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback);
    handler.postDelayed(() -> { if (scanning) { scanner.stopScan(callback); scanning=false; js("window.__linuxLinkNativeError('LinuxLink was not found. Check pairing, power, and Bluetooth.')"); } }, 12000);
  }
  final ScanCallback callback = new ScanCallback() { @Override public void onScanResult(int type, ScanResult result) { if (!scanning) return; scanning=false; scanner.stopScan(this); gatt = result.getDevice().connectGatt(MainActivity.this, false, gattCallback, BluetoothDevice.TRANSPORT_LE); } };
  final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
    @Override public void onConnectionStateChange(BluetoothGatt value, int status, int state) { if (state == BluetoothProfile.STATE_CONNECTED) value.discoverServices(); else { gatt=null; rx=null; writing=false; writes.clear(); js("window.__linuxLinkNativeDisconnected()"); } }
    @Override public void onServicesDiscovered(BluetoothGatt value, int status) { BluetoothGattService service=value.getService(SERVICE); if (status != BluetoothGatt.GATT_SUCCESS || service == null) { js("window.__linuxLinkNativeError('LinuxLink service was not found.')"); return; } rx=service.getCharacteristic(RX); BluetoothGattCharacteristic tx=service.getCharacteristic(TX); if(rx==null||tx==null){js("window.__linuxLinkNativeError('LinuxLink characteristics were not found.')");return;} value.setCharacteristicNotification(tx,true); BluetoothGattDescriptor d=tx.getDescriptor(CCC); if(d==null){js("window.__linuxLinkNativeError('LinuxLink notifications are unavailable.')");return;} d.setValue(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE); value.writeDescriptor(d); }
    @Override public void onDescriptorWrite(BluetoothGatt value, BluetoothGattDescriptor d, int status) { if(status==BluetoothGatt.GATT_SUCCESS) js("window.__linuxLinkNativeConnected()"); else js("window.__linuxLinkNativeError('Could not enable LinuxLink notifications.')"); }
    @Override public void onCharacteristicChanged(BluetoothGatt value, BluetoothGattCharacteristic c) { js("window.__linuxLinkNativeFrame('"+Base64.encodeToString(c.getValue(),Base64.NO_WRAP)+"')"); }
    @Override public void onCharacteristicWrite(BluetoothGatt value, BluetoothGattCharacteristic c, int status) { writing=false; if(status!=BluetoothGatt.GATT_SUCCESS){js("window.__linuxLinkNativeError('Bluetooth write failed.')");return;} writeNext(); }
  };
  void queue(byte[] data) { synchronized(writes){ writes.add(data); } writeNext(); }
  void writeNext() { if(writing || gatt==null || rx==null) return; byte[] data; synchronized(writes){data=writes.poll();} if(data==null)return; writing=true; rx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT); rx.setValue(data); if(!gatt.writeCharacteristic(rx)){writing=false;js("window.__linuxLinkNativeError('Bluetooth write could not start.')");} }
  class Bridge { @JavascriptInterface public void connect(){runOnUiThread(() -> start());} @JavascriptInterface public void disconnect(){runOnUiThread(() -> {if(gatt!=null)gatt.disconnect();});} @JavascriptInterface public void write(String encoded){queue(Base64.decode(encoded,Base64.DEFAULT));} }
}
