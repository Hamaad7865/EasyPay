package com.restopos.core.data

import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.PagingData
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TillDatabase
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

// Offline-first repository (spec 5.1): screens read Flows from Room and
// write to Room. No screen calls the network. Writes (+outbox) land in Phase 2.
@Singleton
class CatalogRepository @Inject constructor(private val db: TillDatabase) {
    fun categories(): Flow<List<CategoryEntity>> = db.catalog().categories()

    fun items(categoryId: String?, query: String): Flow<PagingData<ItemEntity>> =
        Pager(PagingConfig(pageSize = 100, enablePlaceholders = false)) {
            db.catalog().itemsPaged(categoryId?.ifBlank { null }, query.trim())
        }.flow
}
