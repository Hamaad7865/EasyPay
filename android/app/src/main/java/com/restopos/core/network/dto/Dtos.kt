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

// --- Function API (/me, /devices/register, /sync/pull, /signup) ---
@Serializable
data class StoreDto(val id: String, val name: String, val code: String)

@Serializable
data class MeResponse(val tenantId: String, val tenants: List<TenantDto>, val stores: List<StoreDto>)

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

@Serializable
data class SignupRequest(
    val tenantName: String,
    val storeName: String = "Main store",
    val storeCode: String = "S1",
    val ownerName: String = "Owner",
)

@Serializable
data class SignupResponse(val tenantId: String, val storeId: String, val employeeId: String)

// --- sync/pull: { changes: { table: [rows] }, next_cursor, has_more } ---
@Serializable
data class PullResponse(
    val changes: Map<String, List<JsonElement>> = emptyMap(),
    @SerialName("next_cursor") val nextCursor: Long = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
)

// --- sync/push: [{ op_id, type, payload }] -> [{ op_id, status, code?, data? }] ---
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
