package com.restopos.core.network.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// --- Auth (Better Auth REST under NEON_AUTH_BASE_URL) ---
@Serializable
data class AuthRequest(val email: String, val password: String, val name: String = "")

@Serializable
data class AuthUser(val id: String, val email: String, val name: String = "")

@Serializable
data class SessionResponse(val session: SessionInfo? = null, val user: AuthUser? = null)

@Serializable
data class SessionInfo(val token: String = "")

@Serializable
data class TokenResponse(val token: String = "")

// { "message": "Invalid email or password", "code": "INVALID_EMAIL_OR_PASSWORD" }
@Serializable
data class AuthErrorBody(val message: String = "", val code: String = "")

// Function API errors are { "error": "..." }.
@Serializable
data class ApiErrorBody(val error: String = "")

// --- Function API (/me, /devices/register, /sync/pull, /sync/push) ---
@Serializable
data class StoreDto(val id: String, val name: String, val code: String)

// status: active | suspended. A suspended restaurant still syncs; it cannot
// register a till.
@Serializable
data class MeResponse(
    val tenantId: String,
    val tenants: List<TenantDto>,
    val stores: List<StoreDto>,
    val status: String = "active",
)

@Serializable
data class TenantDto(val id: String, val name: String)

@Serializable
data class RegisterDeviceRequest(
    val storeId: String,
    val deviceId: String,
    val name: String,
    val code: String,
    val appVersion: String? = null,
)

@Serializable
data class RegisterDeviceResponse(val deviceId: String, val lastReceiptSeq: Long = 0)

// --- sync/pull: { changes: { table: [rows] }, next_cursor, has_more, epochs } ---
// epochs: per-table counter the server bumps when it rewrites a table's
// history; a change means the cursor is no longer valid.
@Serializable
data class PullResponse(
    val changes: Map<String, List<JsonElement>> = emptyMap(),
    @SerialName("next_cursor") val nextCursor: Long = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
    val epochs: Map<String, Long> = emptyMap(),
)

// --- sync/push: { ops: [{ op_id, type, payload }] } -> [{ op_id, status, code?, data?, replayed? }] ---
// status: applied | rejected | retry. replayed = the server had already seen this op_id.
@Serializable
data class PushRequest(val ops: List<OutboxOp>)

@Serializable
data class OutboxOp(
    @SerialName("op_id") val opId: String,
    val type: String,
    val payload: JsonElement,
)

@Serializable
data class OpResult(
    @SerialName("op_id") val opId: String,
    val status: String,
    val code: String? = null,
    val data: JsonElement? = null,
    val replayed: Boolean = false,
)

@Serializable
data class CategoryRow(
    val id: String,
    @SerialName("tenant_id") val tenantId: String,
    val name: String,
    val color: String? = null,
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("deleted_at") val deletedAt: String? = null,
    @SerialName("server_seq") val serverSeq: Long? = null,
)

@Serializable
data class ItemRow(
    val id: String,
    @SerialName("tenant_id") val tenantId: String,
    @SerialName("category_id") val categoryId: String? = null,
    val name: String,
    val price: Long,
    @SerialName("is_available") val isAvailable: Boolean = true,
    @SerialName("tile_color") val tileColor: String? = null,
    @SerialName("image_path") val imagePath: String? = null,
    @SerialName("deleted_at") val deletedAt: String? = null,
    @SerialName("server_seq") val serverSeq: Long? = null,
)

@Serializable
data class SimpleRow(
    val id: String,
    @SerialName("tenant_id") val tenantId: String? = null,
    val name: String? = null,
    @SerialName("deleted_at") val deletedAt: String? = null,
    @SerialName("server_seq") val serverSeq: Long? = null,
)
