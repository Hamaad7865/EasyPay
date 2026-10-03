package com.restopos.app

import android.content.Context
import androidx.room.Room
import com.restopos.core.database.MIGRATION_1_2
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
    @Provides @Singleton
    fun authClient(@ApplicationContext ctx: Context): AuthClient =
        AuthClient(ctx, com.restopos.app.BuildConfig.AUTH_URL.trimEnd('/') + "/")

    @Provides @Singleton
    fun apiClient(auth: AuthClient): ApiClient =
        ApiClient(com.restopos.app.BuildConfig.FUNCTION_URL.trimEnd('/') + "/", auth)

    @Provides @Singleton
    fun database(@ApplicationContext ctx: Context): TillDatabase =
        Room.databaseBuilder(ctx, TillDatabase::class.java, "till.db")
            // No destructive fallback in release builds (spec 15). Every
            // version bump ships an explicit Migration (see TillDatabase.kt).
            .addMigrations(MIGRATION_1_2)
            .build()

    @Provides @Singleton
    fun sessionStore(@ApplicationContext ctx: Context): SessionStore = SessionStore(ctx)
}
