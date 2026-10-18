package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first

// Whether what is rung up on this tablet now is for trying: it was set up
// before its business sold for real (SessionStore.settingUp), and it works on
// its own. A business in the cloud is cleared from /admin instead (0104).
// docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
suspend fun TillDatabase.tryingOut(session: SessionStore): Boolean =
    session.settingUp.first() && PosSettings.parse(ops().settings()).alone

fun settingUpFlow(db: TillDatabase, session: SessionStore): Flow<Boolean> =
    combine(session.settingUp, db.ops().settingsFlow()) { on, settings -> on && PosSettings.parse(settings).alone }
