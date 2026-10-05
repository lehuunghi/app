package com.lehuunghi.webmail;
import android.app.*;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.RemoteMessage;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import org.json.JSONObject;

public class OfflineMessagingService extends MessagingService {
    @Override public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        OfflineDatabase.EXECUTOR.execute(()->{
            try {
                String data=new OfflineDatabase(this).read("profile","native"); if(data==null)return;
                JSONObject profile=new JSONObject(data);
                if(!profile.optString("binding").equals(message.getData().get("binding")))return;
                OfflineSync.schedule(this,true);
                if(OfflineSync.foreground || message.getNotification()!=null)return;
                NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
                if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel("webmail-new-mail","Email mới",NotificationManager.IMPORTANCE_DEFAULT));
                Intent intent=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("google.message_id",message.getMessageId());
                for(java.util.Map.Entry<String,String> entry:message.getData().entrySet())intent.putExtra(entry.getKey(),entry.getValue());
                PendingIntent tap=PendingIntent.getActivity(this,6414,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                manager.notify("webmail-new-mail",6414,new NotificationCompat.Builder(this,"webmail-new-mail").setSmallIcon(R.drawable.ic_notification).setContentTitle("Webmail").setContentText("Bạn có email mới.").setContentIntent(tap).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
            } catch(Exception ignored) { /* No credentials or mail content in logs. */ }
        });
    }
}
