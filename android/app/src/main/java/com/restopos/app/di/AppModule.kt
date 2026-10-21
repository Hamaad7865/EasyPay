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
            .addMigrations(Migrations.V1_V2, Migrations.V2_V3, Migrations.V3_V4, Migrations.V4_V5, Migrations.V5_V6, Migrations.V6_V7, Migrations.V7_V8, Migrations.V8_V9, Migrations.V9_V10, Migrations.V10_V11, Migrations.V11_V12, Migrations.V12_V13, Migrations.V13_V14, Migrations.V14_V15, Migrations.V15_V16, Migrations.V16_V17, Migrations.V17_V18, Migrations.V18_V19, Migrations.V19_V20, Migrations.V20_V21, Migrations.V21_V22, Migrations.V22_V23, Migrations.V23_V24, Migrations.V24_V25, Migrations.V25_V26, Migrations.V26_V27, Migrations.V27_V28, Migrations.V28_V29, Migrations.V29_V30, Migrations.V30_V31, Migrations.V31_V32)
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
