package com.lehuunghi.webmail;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        OfflineSync.foreground=true;
        registerPlugin(OfflineMailStorePlugin.class);
        registerPlugin(QrLoginScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
    @Override public void onResume() { OfflineSync.foreground=true; super.onResume(); }
    @Override public void onStop() { super.onStop(); OfflineSync.foreground=false; OfflineSync.schedule(this,true); }
}
