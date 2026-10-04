package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// The restaurant's customers: made on a till or in the back office, and the
// same on every till.
@Entity(tableName = "customers")
data class CustomerEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val phone: String? = null,
    val email: String? = null,
    val note: String? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Dao
interface CustomerDao {
    @Upsert suspend fun upsert(rows: List<CustomerEntity>)

    // by name, phone or email; everything when nothing is typed
    @Query(
        """SELECT * FROM customers WHERE deleted_at IS NULL
           AND (:q = '' OR name LIKE '%' || :q || '%' OR phone LIKE '%' || :q || '%' OR email LIKE '%' || :q || '%')
           ORDER BY name COLLATE NOCASE LIMIT 300""",
    )
    fun search(q: String): Flow<List<CustomerEntity>>

    @Query("SELECT * FROM customers WHERE id = :id")
    suspend fun customer(id: String): CustomerEntity?

    @Query("DELETE FROM customers") suspend fun clear()
}
