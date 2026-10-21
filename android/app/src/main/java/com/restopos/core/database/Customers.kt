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
    // Loyalty points (0128): the balance, in cents (a point is a rupee), as
    // this tablet knows it; and the card number the scanner reads, or none.
    val points: Long = 0,
    val card: String? = null,
)

@Dao
interface CustomerDao {
    @Upsert suspend fun upsert(rows: List<CustomerEntity>)

    // by name, phone or email; everything when nothing is typed
    @Query(
        """SELECT * FROM customers WHERE deleted_at IS NULL
           AND (:q = '' OR name LIKE '%' || :q || '%' OR phone LIKE '%' || :q || '%' OR email LIKE '%' || :q || '%' OR card = :q COLLATE NOCASE)
           ORDER BY name COLLATE NOCASE LIMIT 300""",
    )
    fun search(q: String): Flow<List<CustomerEntity>>

    // the customer a card belongs to (a scan, or a card typed on the form)
    @Query("SELECT * FROM customers WHERE card = :card COLLATE NOCASE AND deleted_at IS NULL ORDER BY server_seq DESC LIMIT 1")
    suspend fun byCard(card: String): CustomerEntity?

    // what a sale or a refund made here moved (0128); the server's figure replaces it with the next pull
    @Query("UPDATE customers SET points = points + :delta WHERE id = :id")
    suspend fun addPoints(id: String, delta: Long)

    // Go live: the test sales are gone, and the points they earned with them
    @Query("UPDATE customers SET points = 0")
    suspend fun clearPoints()

    // A sale, refund or exchange of this customer made here and not sent yet:
    // the server's balance is older than the tablet's until it has gone up.
    @Query("""SELECT COUNT(*) FROM outbox WHERE state = 'pending'
              AND type IN ('receipt.create', 'refund.create') AND payload LIKE '%' || :id || '%'""")
    suspend fun waitingPoints(id: String): Int

    // every customer, for naming the deposits on their list (0113)
    @Query("SELECT * FROM customers")
    fun everyone(): Flow<List<CustomerEntity>>

    @Query("SELECT * FROM customers WHERE id = :id")
    suspend fun customer(id: String): CustomerEntity?

    @Query("DELETE FROM customers") suspend fun clear()
}
