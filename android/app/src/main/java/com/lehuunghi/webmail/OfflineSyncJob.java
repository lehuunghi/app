package com.lehuunghi.webmail;
import android.app.job.JobService;
import android.app.job.JobParameters;
public class OfflineSyncJob extends JobService {
    @Override public boolean onStartJob(JobParameters p) {
        if (OfflineSync.foreground) return false;
        OfflineSync.cancelled=false;
        OfflineDatabase.EXECUTOR.execute(()->jobFinished(p,!new OfflineSync(this).run())); return true;
    }
    @Override public boolean onStopJob(JobParameters p) { OfflineSync.cancelled=true; return true; }
}
