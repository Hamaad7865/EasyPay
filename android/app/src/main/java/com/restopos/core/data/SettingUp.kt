package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first

// Whether what is rung up on this tablet now is for trying.
//   - A tablet that works on its own: it was set up before its business sold
//     for real (SessionStore.settingUp). Its Go live is its own, and what its
//     sales take off the shelf is noted to be put back then (tryingOut).
//   - A business in the cloud: the server says it is being set up (settings
//     settingUp, server 0157). Its Go live is the server's, which puts the
//     stock back and tells every till to empty itself; nothing is noted here.
// Either way the tablet marks its papers TEST and offers Go live (settingUpFlow).
// docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
suspend fun TillDatabase.tryingOut(session: SessionStore): Boolean =
    session.settingUp.first() && PosSettings.parse(ops().settings()).alone

// own: the tablet's own flag (SessionStore.settingUp)
fun settingUpNow(own: Boolean, settings: PosSettings): Boolean =
    (own && settings.alone) || (settings.cloud && settings.settingUp)

fun settingUpFlow(db: TillDatabase, session: SessionStore): Flow<Boolean> =
    combine(session.settingUp, db.ops().settingsFlow()) { on, settings -> settingUpNow(on, PosSettings.parse(settings)) }
