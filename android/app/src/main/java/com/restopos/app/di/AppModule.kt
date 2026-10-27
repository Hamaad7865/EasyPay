package com.restopos.app

import android.content.Context
import androidx.room.Room
import com.restopos.core.database.Migrations
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.network.AuthClient
import com.restopos.core.sync.SessionStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    // Both clients normalise the base URL themselves (no trailing slash), so a
    // slash in local.properties cannot double up in the request path.
    @Provides @Singleton
    fun authClient(@ApplicationContext ctx: Context): AuthClient =
        AuthClient(ctx, BuildConfig.AUTH_URL)

    @Provides @Singleton
    fun apiClient(auth: AuthClient): ApiClient =
        ApiClient(BuildConfig.FUNCTION_URL, auth, BuildConfig.VERSION_CODE)

    // where the Z report is mailed (cloudflare/mail); a debug build may be given another (mailUrl)
    @Provides @Singleton
    fun mailClient(): com.restopos.core.network.MailClient =
        com.restopos.core.network.MailClient(BuildConfig.MAIL_URL.ifBlank { com.restopos.core.network.MailClient.LIVE })

    @Provides @Singleton
    fun database(@ApplicationContext ctx: Context): TillDatabase =
        Room.databaseBuilder(ctx, TillDatabase::class.java, "till.db")
            // No destructive fallback (spec 15): a version bump without its
            // Migration fails loudly instead of wiping unsynced sales.
            .addMigrations(*Migrations.ALL.toTypedArray())
            .build()

    // What a tablet set up as a kitchen screen keeps (core/kitchen): its own
    // file, so a till's database has none of it and it has none of a till's.
    @Provides @Singleton
    fun kitchenDatabase(@ApplicationContext ctx: Context): com.restopos.core.kitchen.KitchenDatabase =
        Room.databaseBuilder(ctx, com.restopos.core.kitchen.KitchenDatabase::class.java, "kitchen.db")
            .addMigrations(com.restopos.core.kitchen.KitchenDatabase.V1_V2)
            .build()

    @Provides @Singleton
    fun sessionStore(@ApplicationContext ctx: Context): SessionStore = SessionStore(ctx)
}
