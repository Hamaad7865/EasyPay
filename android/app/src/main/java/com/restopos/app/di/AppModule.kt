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

    @Provides @Singleton
    fun database(@ApplicationContext ctx: Context): TillDatabase =
        Room.databaseBuilder(ctx, TillDatabase::class.java, "till.db")
            // No destructive fallback (spec 15): a version bump without its
            // Migration fails loudly instead of wiping unsynced sales.
            .addMigrations(Migrations.V1_V2, Migrations.V2_V3, Migrations.V3_V4, Migrations.V4_V5, Migrations.V5_V6, Migrations.V6_V7)
            .build()

    @Provides @Singleton
    fun sessionStore(@ApplicationContext ctx: Context): SessionStore = SessionStore(ctx)
}
