package com.lehuunghi.webmail;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** SQLite rows are AES-GCM encrypted; account/key identifiers are authenticated as AAD. */
final class OfflineDatabase {
    static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final String ALIAS = "webmail.offline.v1";
    private final Context context;
    OfflineDatabase(Context context) { this.context = context.getApplicationContext(); }
    private SQLiteDatabase open() {
        SQLiteDatabase db = context.openOrCreateDatabase("offline-mail-v1.db", Context.MODE_PRIVATE, null);
        db.execSQL("PRAGMA synchronous=FULL");
        db.execSQL("CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, key TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(scope,key))");
        db.execSQL("CREATE TABLE IF NOT EXISTS chunks (scope TEXT NOT NULL, key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(scope,key,part))");
        return db;
    }
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }
    private byte[] seal(String scope, String name, String text) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD((scope + "\u0000" + name).getBytes(StandardCharsets.UTF_8));
        byte[] data = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8)), iv = cipher.getIV();
        byte[] out = new byte[iv.length + data.length]; System.arraycopy(iv,0,out,0,iv.length); System.arraycopy(data,0,out,iv.length,data.length); return out;
    }
    private String unseal(String scope, String name, byte[] data) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(data,0,12)));
        cipher.updateAAD((scope + "\u0000" + name).getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Arrays.copyOfRange(data,12,data.length)), StandardCharsets.UTF_8);
    }
    String read(String scope, String name) throws Exception {
        try (SQLiteDatabase db = open(); Cursor c = db.rawQuery("SELECT data FROM records WHERE scope=? AND key=?",new String[]{scope,name})) {
            return c.moveToFirst() ? readChunks(db,scope,name,c.getBlob(0)) : null;
        }
    }
    private String readChunks(SQLiteDatabase db, String scope, String name, byte[] header) throws Exception {
        int count = new JSONObject(unseal(scope,name,header)).getInt("chunks");
        StringBuilder text = new StringBuilder();
        try(Cursor cursor=db.rawQuery("SELECT part,data FROM chunks WHERE scope=? AND key=? ORDER BY part",new String[]{scope,name})) {
            int expected=0;
            while(cursor.moveToNext()) {
                int part=cursor.getInt(0); if(part!=expected++) throw new IllegalStateException("Incomplete record");
                text.append(unseal(scope,name+"\u0000"+part,cursor.getBlob(1)));
            }
            if(expected!=count) throw new IllegalStateException("Incomplete record");
        }
        return text.toString();
    }
    JSONObject list(String scope, String prefix) throws Exception {
        JSONObject out = new JSONObject();
        try (SQLiteDatabase db = open(); Cursor c = db.rawQuery("SELECT key,data FROM records WHERE scope=?",new String[]{scope})) {
            while(c.moveToNext()) { String name=c.getString(0); if(name.startsWith(prefix)) out.put(name,readChunks(db,scope,name,c.getBlob(1))); }
        }
        return out;
    }
    void commit(String scope, JSONArray changes) throws Exception {
        try(SQLiteDatabase db=open()) {
            db.beginTransaction();
            try {
                for(int i=0;i<changes.length();i++) {
                    JSONObject change=changes.getJSONObject(i); String name=change.getString("key");
                    db.execSQL("DELETE FROM chunks WHERE scope=? AND key=?",new Object[]{scope,name});
                    if(change.isNull("value") || !change.has("value")) db.execSQL("DELETE FROM records WHERE scope=? AND key=?",new Object[]{scope,name});
                    else {
                        String value=change.getString("value"); int offset=0,part=0;
                        // Bounded rows avoid Android CursorWindow's per-row size limit.
                        while(offset<value.length()) {
                            int end=Math.min(value.length(),offset+256000);
                            if(end<value.length() && Character.isHighSurrogate(value.charAt(end-1))) end--;
                            db.execSQL("INSERT INTO chunks(scope,key,part,data) VALUES(?,?,?,?)",new Object[]{scope,name,part,seal(scope,name+"\u0000"+part,value.substring(offset,end))});
                            part++; offset=end;
                        }
                        db.execSQL("INSERT OR REPLACE INTO records(scope,key,data) VALUES(?,?,?)",new Object[]{scope,name,seal(scope,name,new JSONObject().put("chunks",part).toString())});
                    }
                }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        }
    }
    long bytes(String scope) {
        try(SQLiteDatabase db=open(); Cursor c=db.rawQuery("SELECT COALESCE(SUM(length(data)),0) FROM chunks WHERE scope=?",new String[]{scope})) { return c.moveToFirst()?c.getLong(0):0; }
    }
    void clear() throws Exception {
        context.deleteDatabase("offline-mail-v1.db");
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null); if(ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
    }
}
