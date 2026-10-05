package com.lehuunghi.webmail;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

@CapacitorPlugin(name = "QrLoginScanner")
public class QrLoginScannerPlugin extends Plugin {
    private boolean scanning;
    @PluginMethod public void scan(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (scanning) { call.reject("Scanner is already open", "busy"); return; }
            scanning = true;
            GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build();
            GmsBarcodeScanning.getClient(getActivity(), options).startScan()
                .addOnSuccessListener(barcode -> {
                    scanning = false;
                    String value = barcode.getRawValue();
                    if (value == null) { call.reject("No QR value", "scan_failed"); return; }
                    JSObject result = new JSObject(); result.put("value", value); call.resolve(result);
                })
                .addOnCanceledListener(() -> { scanning = false; call.reject("Cancelled", "cancelled"); })
                .addOnFailureListener(error -> { scanning = false; call.reject("Scanner unavailable. Update Google Play services and try again.", "scan_failed"); });
        });
    }
}
