package com.lehuunghi.webmail;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OfflineMailStore")
public class OfflineMailStorePlugin extends Plugin {
    private interface Task { JSObject run() throws Exception; }
    private void execute(PluginCall call, Task task) {
        OfflineDatabase.EXECUTOR.execute(() -> { try { call.resolve(task.run()); } catch(Exception e) { call.reject("Không thể lưu hoặc đọc dữ liệu trên máy.","offline_storage_error",e); } });
    }
    private OfflineDatabase db() { return new OfflineDatabase(getContext()); }
    @PluginMethod public void read(PluginCall call) { execute(call,()-> { JSObject out=new JSObject(); String value=db().read(call.getString("scope",""),call.getString("key","")); out.put("value",value==null?org.json.JSONObject.NULL:value); return out; }); }
    @PluginMethod public void list(PluginCall call) { execute(call,()-> { JSObject out=new JSObject(); out.put("values",db().list(call.getString("scope",""),call.getString("prefix",""))); return out; }); }
    @PluginMethod public void commit(PluginCall call) { execute(call,()-> { db().commit(call.getString("scope",""),call.getArray("changes")); return new JSObject(); }); }
    @PluginMethod public void bytes(PluginCall call) { execute(call,()-> { JSObject out=new JSObject(); out.put("bytes",db().bytes(call.getString("scope",""))); return out; }); }
    @PluginMethod public void clear(PluginCall call) { OfflineSync.cancel(getContext()); execute(call,()-> { db().clear(); return new JSObject(); }); }
    @PluginMethod public void configure(PluginCall call) { OfflineSync.foreground=call.getBoolean("active",true); execute(call,()-> { new OfflineSync(getContext()).configure(call.getString("scope",""),call.getString("accountId",""),call.getBoolean("active",true),call.getString("binding")); return new JSObject(); }); }
    @PluginMethod public void sync(PluginCall call) { OfflineSync.schedule(getContext(),true); call.resolve(); }
}
