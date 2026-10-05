package com.lehuunghi.webmail;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class OfflineDatabaseTest {
    @Test public void encryptedLargeRecordsSurviveReopenAndFailedTransactionsRollback() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        OfflineDatabase db=new OfflineDatabase(context);
        // Instrumentation runs only on the clean CI simulator. Refuse to erase a signed-in device.
        assertNull(db.read("profile","active"));
        OfflineSync.cancel(context); db.clear();
        try {
            StringBuilder text=new StringBuilder();for(int i=0;i<400000;i++)text.append("Thư riêng 🔐\n");
            String large=text.toString();
            db.commit("test",new JSONArray().put(new JSONObject().put("key","full:mail").put("value",large)).put(new JSONObject().put("key","mail:mail").put("value","secret-subject")));
            assertEquals(large,new OfflineDatabase(context).read("test","full:mail"));
            assertEquals("secret-subject",db.list("test","mail:").getString("mail:mail"));
            try(SQLiteDatabase sqlite=context.openOrCreateDatabase("offline-mail-v1.db",Context.MODE_PRIVATE,null);Cursor c=sqlite.rawQuery("SELECT data FROM chunks",null)) {
                while(c.moveToNext())assertFalse(new String(c.getBlob(0),StandardCharsets.ISO_8859_1).contains("secret-subject"));
            }
            try { db.commit("test",new JSONArray().put(new JSONObject().put("key","mail:mail").put("value","changed")).put(new JSONObject().put("value","invalid")));fail("Invalid transaction committed"); } catch(JSONException expected) { }
            assertEquals("secret-subject",db.read("test","mail:mail"));
            assertTrue(db.bytes("test")>large.length());
            db.clear();assertNull(db.read("test","mail:mail"));
            KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);assertFalse(keys.containsAlias("webmail.offline.v1"));
        } finally { db.clear(); }
    }
}
