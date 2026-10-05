package com.lehuunghi.webmail;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.webkit.CookieManager;
import android.util.Base64;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Native background peer of the JS repository. Both share the database's serial executor. */
final class OfflineSync {
    static volatile boolean foreground = false;
    static volatile boolean cancelled = false;
    private static final String API="https://webmail.jmail.vn", CORE="urn:ietf:params:jmap:core", MAIL="urn:ietf:params:jmap:mail";
    static final int PERIODIC=6412, NOW=6413;
    private final Context context; private final OfflineDatabase db;
    private JSONObject config, manifest; private String scope; private long deadline;
    OfflineSync(Context context) { this.context=context.getApplicationContext(); db=new OfflineDatabase(context); }
    static void schedule(Context context, boolean immediate) {
        JobScheduler scheduler=(JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        JobInfo.Builder b=new JobInfo.Builder(immediate?NOW:PERIODIC,new ComponentName(context,OfflineSyncJob.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL);
        if(immediate) b.setMinimumLatency(1000); else b.setPeriodic(15*60*1000).setPersisted(true);
        scheduler.schedule(b.build());
    }
    static void cancel(Context context) { foreground=true; JobScheduler s=(JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE); s.cancel(PERIODIC); s.cancel(NOW); }
    void configure(String scope, String account, boolean active, String binding) throws Exception {
        foreground=active;
        String cookie=CookieManager.getInstance().getCookie(API);
        JSONObject previous=read("profile","native");
        JSONObject c=new JSONObject().put("scope",scope).put("accountId",account).put("cookie",cookie==null?"":cookie).put("binding",binding==null && previous!=null && scope.equals(previous.optString("scope"))?previous.optString("binding"):binding==null?"":binding);
        db.commit("profile",changes("native",c.toString()));
        if(active) ((JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE)).cancel(NOW);
        else { schedule(context,false); schedule(context,true); }
    }
    static JSONArray changes(String key, Object value) throws JSONException { return new JSONArray().put(new JSONObject().put("key",key).put("value",value)); }
    private JSONObject read(String s,String key) throws Exception { String v=db.read(s,key); return v==null?null:new JSONObject(v); }
    private void check() throws IOException { if(foreground || cancelled || System.currentTimeMillis()>deadline) throw new IOException("paused"); }
    private void save(JSONArray changes) throws Exception { check(); changes.put(new JSONObject().put("key","manifest").put("value",manifest.toString())); db.commit(scope,changes); }
    private byte[] network(String path,String type,byte[] body) throws Exception {
        check(); if(!path.startsWith("/api/")) throw new IOException("invalid path");
        HttpURLConnection c=(HttpURLConnection)new URL(API+path).openConnection(); c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(8000); c.setReadTimeout(8000); c.setRequestProperty("Cookie",config.getString("cookie")); c.setRequestProperty("X-Requested-With","ihasmail");
        try {
            if(body!=null) { c.setRequestMethod("POST"); c.setRequestProperty("Content-Type",type); c.setDoOutput(true); c.setFixedLengthStreamingMode(body.length); try(OutputStream out=c.getOutputStream()){out.write(body);} }
            int status=c.getResponseCode();
            if(status==401) { JSONObject p=read("profile","active"); if(p!=null)db.commit("profile",changes("active",p.put("expired",true).toString())); db.commit("profile",changes("native",JSONObject.NULL)); cancel(context); throw new IOException("unauthenticated"); }
            if(status<200 || status>=300) { String code="connection_error"; if(c.getErrorStream()!=null) { try { code=new JSONObject(new String(readError(c.getErrorStream()),StandardCharsets.UTF_8)).optString("error",code); } catch(Exception ignored){} } throw new HttpFailure(status,code); }
            long available=Math.max(0,manifest.getLong("maxBytes")-db.bytes(scope));
            long length=c.getContentLengthLong(); if(length>available && body==null)throw new IOException("offline_storage_full");
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()) {byte[] buffer=new byte[32768];int n;while((n=in.read(buffer))!=-1){check();if(out.size()+n>Math.min(128L*1024*1024,body==null?available:128L*1024*1024))throw new IOException("offline_storage_full");out.write(buffer,0,n);}return out.toByteArray();}
        } finally { c.disconnect(); }
    }
    private byte[] readError(InputStream in) throws IOException { ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] buffer=new byte[1024]; int n; while(out.size()<8192 && (n=in.read(buffer))!=-1)out.write(buffer,0,n); return out.toByteArray(); }
    static final class HttpFailure extends IOException { final int status; final String code; HttpFailure(int status,String code){super(code);this.status=status;this.code=code;} }
    private JSONObject post(String path,JSONObject input) throws Exception { return new JSONObject(new String(network(path,"application/json",input.toString().getBytes(StandardCharsets.UTF_8)),StandardCharsets.UTF_8)); }
    private JSONObject call(String name,JSONObject args) throws Exception {
        args.put("accountId",manifest.getString("accountId"));
        JSONObject response=post("/api/jmap",new JSONObject().put("using",new JSONArray().put(CORE).put(MAIL)).put("methodCalls",new JSONArray().put(new JSONArray().put(name).put(args).put("native"))));
        JSONArray invocation=response.getJSONArray("methodResponses").getJSONArray(0); if(invocation.getString(0).equals("error"))throw new IOException(invocation.getJSONObject(1).optString("type")); return invocation.getJSONObject(1);
    }
    static Object replace(Object v,JSONObject map) throws JSONException {
        if(v instanceof String)return map.opt((String)v)==null?v:map.get((String)v);
        if(v instanceof JSONArray){JSONArray out=new JSONArray();for(int i=0;i<((JSONArray)v).length();i++)out.put(replace(((JSONArray)v).get(i),map));return out;}
        if(v instanceof JSONObject){JSONObject out=new JSONObject();Iterator<String> keys=((JSONObject)v).keys();while(keys.hasNext()){String k=keys.next(),mapped=map.optString(k,k);if(mapped.equals(k)){String[] segments=k.split("/",-1);for(int i=0;i<segments.length;i++)segments[i]=map.optString(segments[i],segments[i]);mapped=android.text.TextUtils.join("/",segments);}out.put(mapped,replace(((JSONObject)v).get(k),map));}return out;}return v;
    }
    private boolean unresolved(Object value,String field) throws JSONException {
        if(Arrays.asList("value","subject","name","preview").contains(field)||field.startsWith("header:"))return false;
        if(value instanceof String)return ((String)value).startsWith("offline:");
        if(value instanceof JSONArray){for(int i=0;i<((JSONArray)value).length();i++)if(unresolved(((JSONArray)value).get(i),field))return true;}
        if(value instanceof JSONObject){Iterator<String> keys=((JSONObject)value).keys();while(keys.hasNext()){String k=keys.next();if(k.startsWith("offline:")||unresolved(((JSONObject)value).get(k),k))return true;}}return false;
    }
    private void blobs(Object value,Set<String> ids) throws JSONException {
        if(value instanceof JSONObject){JSONObject o=(JSONObject)value;if(o.optString("blobId").startsWith("offline:blob:"))ids.add(o.getString("blobId"));Iterator<String> keys=o.keys();while(keys.hasNext())blobs(o.get(keys.next()),ids);}
        if(value instanceof JSONArray)for(int i=0;i<((JSONArray)value).length();i++)blobs(((JSONArray)value).get(i),ids);
    }
    private void flush() throws Exception {
        JSONArray operations=manifest.getJSONArray("operations");
        for(int i=0;i<operations.length();i++) {
            check();JSONObject op=operations.getJSONObject(i);if(op.getString("status").equals("failed")||op.getLong("readyAt")>System.currentTimeMillis())continue;
            try {
                JSONObject mappings=manifest.getJSONObject("mappings");Set<String> ids=new HashSet<>();blobs(op.getJSONObject("request"),ids);
                for(String id:ids)if(!mappings.has(id)){JSONObject blob=read(scope,"pendingBlob:"+id);if(blob==null)throw new HttpFailure(409,"offline_attachment_missing");JSONObject up=new JSONObject(new String(network("/api/upload/"+enc(manifest.getString("accountId")),blob.getString("type"),Base64.decode(blob.getString("data"),Base64.DEFAULT)),StandardCharsets.UTF_8));mappings.put(id,up.getString("blobId"));save(changes("blob:"+up.getString("blobId"),blob.toString()).put(new JSONObject().put("key","pendingBlob:"+id).put("value",JSONObject.NULL)));}
                JSONObject request=(JSONObject)replace(op.getJSONObject("request"),mappings);if(unresolved(request,""))throw new HttpFailure(409,"offline_dependency_missing");
                JSONObject res=post("/api/offline/jmap/"+enc(op.getString("id")),new JSONObject().put("request",request).put("base",replace(op.getJSONObject("base"),mappings)));
                JSONArray responses=res.getJSONArray("methodResponses"),writes=new JSONArray();boolean errors=false,sendAccepted=false;
                for(int j=0;j<responses.length();j++){JSONArray r=responses.getJSONArray(j);JSONObject a=r.getJSONObject(1);if(r.getString(0).equals("EmailSubmission/set")&&a.optJSONObject("created")!=null&&a.getJSONObject("created").length()>0)sendAccepted=true;if(r.getString(0).equals("error"))errors=true;for(String k:Arrays.asList("notCreated","notUpdated","notDestroyed"))if(a.optJSONObject(k)!=null&&a.getJSONObject(k).length()>0)errors=true;}
                for(int j=0;j<responses.length();j++){JSONArray r=responses.getJSONArray(j);JSONObject args=r.getJSONObject(1);if(r.getString(0).equals("error"))errors=true;for(String key:Arrays.asList("notCreated","notUpdated","notDestroyed"))if(args.optJSONObject(key)!=null&&args.getJSONObject(key).length()>0)errors=true;
                    JSONObject created=args.optJSONObject("created"),local=op.getJSONObject("creations").optJSONObject(r.getString(2));if(created!=null&&local!=null){Iterator<String> keys=created.keys();while(keys.hasNext()){String key=keys.next();if(local.has(key)){String id=local.getString(key);mappings.put(id,created.getJSONObject(key).getString("id"));if(!errors||sendAccepted)writes.put(new JSONObject().put("key","mail:"+id).put("value",JSONObject.NULL)).put(new JSONObject().put("key","full:"+id).put("value",JSONObject.NULL));}}}}
                if(errors)op.put("sendAccepted",sendAccepted).put("status","failed").put("error","offline_operation_rejected");else {operations.remove(i--);}save(writes);
            } catch(HttpFailure e) { if(e.status>=500||e.status==429)throw e;if(e.code.equals("operation_in_progress"))continue;op.put("status",(e.code.equals("operation_uncertain")||e.code.equals("operation_id_reused"))?"uncertain":"failed").put("error",e.code);save(new JSONArray()); }
        }
    }
    private boolean deleted(String id) throws Exception { return deleted(id,"Email/set"); }
    private boolean deleted(String id,String method) throws Exception {JSONArray ops=manifest.getJSONArray("operations");for(int i=0;i<ops.length();i++){JSONArray calls=((JSONObject)replace(ops.getJSONObject(i).get("request"),manifest.getJSONObject("mappings"))).getJSONArray("methodCalls");for(int j=0;j<calls.length();j++){JSONArray call=calls.getJSONArray(j);JSONArray destroy=call.getJSONObject(1).optJSONArray("destroy");if(call.getString(0).equals(method)&&destroy!=null)for(int k=0;k<destroy.length();k++)if(id.equals(destroy.getString(k)))return true;}}return false;}
    private JSONObject overlay(JSONObject email) throws Exception { return overlay(email,"Email/set"); }
    private JSONObject overlay(JSONObject email,String method) throws Exception {JSONArray ops=manifest.getJSONArray("operations");for(int i=0;i<ops.length();i++){JSONArray calls=((JSONObject)replace(ops.getJSONObject(i).get("request"),manifest.getJSONObject("mappings"))).getJSONArray("methodCalls");for(int j=0;j<calls.length();j++){JSONArray call=calls.getJSONArray(j);JSONObject updates=call.getJSONObject(1).optJSONObject("update");JSONObject patch=updates==null?null:updates.optJSONObject(email.getString("id"));if(call.getString(0).equals(method)&&patch!=null){Iterator<String> keys=patch.keys();while(keys.hasNext()){String path=keys.next();String[] pieces=path.split("/");JSONObject target=email;for(int k=0;k<pieces.length-1;k++){String key=pieces[k].replace("~1","/").replace("~0","~");if(!target.has(key))target.put(key,new JSONObject());target=target.getJSONObject(key);}String key=pieces[pieces.length-1].replace("~1","/").replace("~0","~");if(patch.isNull(path))target.remove(key);else target.put(key,patch.get(path));}}}}return email;}
    private void pull() throws Exception {
        boolean more=true;
        while(more){check();JSONObject rows=db.list(scope,"mail:");JSONArray known=new JSONArray();Iterator<String> keys=rows.keys();while(keys.hasNext()){String id=keys.next().substring(5);if(!id.startsWith("offline:")&&known.length()<10000)known.put(id);}
            JSONObject input=new JSONObject().put("accountId",manifest.getString("accountId")).put("sinceState",manifest.opt("emailState")).put("knownIds",known).put("historyDays",manifest.getInt("historyDays")).put("maxMessages",manifest.getInt("maxMessages")).put("snapshot",manifest.opt("backgroundPull"));
            JSONObject result=post("/api/offline/pull",input);JSONArray changes=new JSONArray();JSONArray list=result.getJSONArray("list"),removed=result.getJSONArray("removed");
            for(int i=0;i<removed.length();i++){String id=removed.getString(i);changes.put(new JSONObject().put("key","mail:"+id).put("value",JSONObject.NULL)).put(new JSONObject().put("key","full:"+id).put("value",JSONObject.NULL));}
            for(int i=0;i<list.length();i++){JSONObject email=list.getJSONObject(i);String id=email.getString("id");if(deleted(id))continue;JSONObject old=read(scope,"mail:"+id);JSONObject row=new JSONObject().put("email",overlay(email)).put("full",old!=null&&old.optBoolean("full")).put("complete",old!=null&&old.optBoolean("complete")).put("pinned",old!=null&&old.optBoolean("pinned"));changes.put(new JSONObject().put("key","mail:"+id).put("value",row.toString()));}
            JSONArray boxes=result.getJSONArray("mailboxes"),oldBoxes=manifest.getJSONArray("mailboxes");for(int i=0;i<oldBoxes.length();i++){String id=oldBoxes.getJSONObject(i).getString("id");if(id.startsWith("offline:")&&!manifest.getJSONObject("mappings").has(id))boxes.put(oldBoxes.getJSONObject(i));}
            JSONArray pendingBoxes=new JSONArray();for(int i=0;i<boxes.length();i++){JSONObject box=boxes.getJSONObject(i);if(!deleted(box.getString("id"),"Mailbox/set"))pendingBoxes.put(overlay(box,"Mailbox/set"));}boxes=pendingBoxes;
            manifest.put("emailState",result.opt("state")).put("backgroundPull",result.opt("snapshot")).put("mailboxes",boxes).put("mailboxState",result.get("mailboxState")).put("identities",result.get("identities"));save(changes);more=result.getBoolean("more");
        }
    }
    private static String enc(String value) {try{return URLEncoder.encode(value,"UTF-8").replace("+","%20");}catch(Exception e){throw new IllegalArgumentException(e);}}
    private void parts(Object part,Map<String,JSONObject> out) throws JSONException {if(part instanceof JSONArray){for(int i=0;i<((JSONArray)part).length();i++)parts(((JSONArray)part).get(i),out);}if(part instanceof JSONObject){JSONObject p=(JSONObject)part;if(!p.optString("blobId").isEmpty())out.put(p.getString("blobId"),p);if(p.has("subParts"))parts(p.get("subParts"),out);}}
    private void full() throws Exception {
        JSONObject rows=db.list(scope,"mail:");Iterator<String> keys=rows.keys();
        while(keys.hasNext()){check();String key=keys.next(),id=key.substring(5);JSONObject row=new JSONObject(rows.getString(key));if(row.optBoolean("complete")||id.startsWith("offline:"))continue;
            if(db.bytes(scope)>=manifest.getLong("maxBytes"))throw new IOException("offline_storage_full");
            JSONObject email=read(scope,"full:"+id);
            if(email==null){JSONArray props=new JSONArray(Arrays.asList("id","blobId","threadId","mailboxIds","keywords","from","to","cc","bcc","replyTo","sender","subject","receivedAt","sentAt","size","preview","hasAttachment","messageId","inReplyTo","references","bodyStructure","bodyValues","textBody","htmlBody","attachments","header:List-Unsubscribe:asText","header:List-Unsubscribe-Post:asText","header:List-Id:asText","header:Disposition-Notification-To:asAddresses","header:X-Priority:asText","header:Importance:asText","header:Auto-Submitted:asText","header:Precedence:asText","header:Authentication-Results:asText","header:X-Spam-Status:asText","header:X-Spam-Score:asText","header:X-Spamd-Result:asText"));JSONArray list=call("Email/get",new JSONObject().put("ids",new JSONArray().put(id)).put("properties",props).put("fetchTextBodyValues",true).put("fetchHTMLBodyValues",true).put("maxBodyValueBytes",2*1024*1024).put("bodyProperties",new JSONArray(Arrays.asList("partId","blobId","size","name","type","charset","disposition","cid","subParts")))).getJSONArray("list");if(list.length()==0)continue;email=list.getJSONObject(0);}
            boolean bodyFull=true;JSONObject earlyValues=email.optJSONObject("bodyValues");if(earlyValues!=null){Iterator<String> p=earlyValues.keys();while(p.hasNext())if(earlyValues.getJSONObject(p.next()).optBoolean("isTruncated"))bodyFull=false;}row.put("full",bodyFull);
            save(changes("full:"+id,email.toString()).put(new JSONObject().put("key",key).put("value",row.toString())));
            Map<String,JSONObject> parts=new LinkedHashMap<>();for(String field:Arrays.asList("bodyStructure","textBody","htmlBody","attachments"))parts(email.opt(field),parts);
            for(Map.Entry<String,JSONObject> entry:parts.entrySet()){check();String blobId=entry.getKey();JSONObject part=entry.getValue(),blob=read(scope,"blob:"+blobId);byte[] bytes;
                if(blob==null){bytes=network("/api/blob/"+enc(manifest.getString("accountId"))+"/"+enc(blobId)+"/blob?accept="+enc(part.optString("type","application/octet-stream")),null,null);if(db.bytes(scope)+bytes.length*1.4>manifest.getLong("maxBytes"))throw new IOException("offline_storage_full");blob=new JSONObject().put("type",part.optString("type","application/octet-stream")).put("size",bytes.length).put("data",Base64.encodeToString(bytes,Base64.NO_WRAP));save(changes("blob:"+blobId,blob.toString()));}else bytes=Base64.decode(blob.getString("data"),Base64.DEFAULT);
                JSONObject values=email.optJSONObject("bodyValues"),value=values==null?null:values.optJSONObject(part.optString("partId"));if(value!=null&&value.optBoolean("isTruncated")){String charset=part.optString("charset","UTF-8");if(charset.isEmpty())charset="UTF-8";value.put("value",new String(bytes,charset)).put("isTruncated",false);}
            }
            JSONObject bodyValues=email.optJSONObject("bodyValues");if(bodyValues!=null){Iterator<String> p=bodyValues.keys();while(p.hasNext())if(bodyValues.getJSONObject(p.next()).optBoolean("isTruncated"))throw new IOException("offline_body_incomplete");}
            row.put("full",true).put("complete",true);save(changes("full:"+id,email.toString()).put(new JSONObject().put("key",key).put("value",row.toString())));
        }
    }
    boolean run() {
        deadline=System.currentTimeMillis()+25000;
        try {config=read("profile","native");JSONObject profile=read("profile","active");if(config==null||profile==null||profile.optBoolean("expired")||foreground||config.optString("cookie").isEmpty())return true;scope=config.getString("scope");if(!scope.equals(profile.optString("scope")))return true;manifest=read(scope,"manifest");if(manifest==null||!manifest.getString("accountId").equals(config.getString("accountId"))||manifest.getJSONObject("session").getJSONObject("ihasmail").optInt("offlineSync")!=1)return true;
            flush();pull();full();manifest.put("lastSync",System.currentTimeMillis());save(new JSONArray());return true;
        } catch(Exception e){return foreground || System.currentTimeMillis()>deadline;}
    }
}
