package com.restopos.feature.setup

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.restopos.app.BuildConfig
import com.restopos.core.data.SetupFacts
import com.restopos.core.data.SetupStep
import com.restopos.core.data.SetupSteps
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Motion
import com.restopos.core.ui.T
import com.restopos.core.ui.ToastHost
import com.restopos.core.ui.V
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.Wordmark
import com.restopos.core.ui.panel
import com.restopos.core.ui.press
import com.restopos.feature.auth.Heading
import com.restopos.feature.auth.MainKey
import com.restopos.feature.auth.QuietLink

// The first-run set-up: one step a screen, then a summary. It follows "Name
// this till" for a business whose set-up is open (first = true), and opens
// again later from the start screen and from Settings, on the summary.
// Everything is one card, in the style of the sign-in and "Name this till"
// cards before it and wider, so it reads as their next step.

private const val SUMMARY = "summary"

@Composable
fun SetupScreen(first: Boolean, onDone: () -> Unit, vm: SetupViewModel = hiltViewModel()) {
    val facts by vm.facts.collectAsState()
    val company by vm.company.collectAsState()
    val open by vm.open.collectAsState()
    val f = facts
    val business = company?.name.orEmpty()
    // Where it is: a step's name, or the summary. Nowhere until what the
    // business has was read: a first run starts at the first step not done.
    var at by rememberSaveable { mutableStateOf<String?>(null) }
    // the step was opened from the summary, and goes back to it
    var back by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(f != null) {
        if (f != null && at == null) at = if (first) SetupSteps.first(f)?.name ?: SUMMARY else SUMMARY
    }
    val steps = SetupSteps.of(f?.retail == true)
    val step = steps.firstOrNull { it.name == at }
    fun go(to: String, fromSummary: Boolean = false) { vm.clear(); back = fromSummary; at = to }
    val next: () -> Unit = {
        val i = steps.indexOf(step)
        go(if (back || i < 0 || i == steps.lastIndex) SUMMARY else steps[i + 1].name)
    }
    BackHandler {
        val i = steps.indexOf(step)
        when {
            at == SUMMARY -> if (first) go(steps.last().name) else onDone()
            step != null && back -> go(SUMMARY)
            i > 0 -> go(steps[i - 1].name)
            first -> Unit // the first step of a first run: there is nothing before it
            else -> onDone()
        }
    }

    Box(Modifier.fillMaxSize().background(V.Bg).systemBarsPadding().imePadding()) {
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 940.dp).fillMaxWidth().fillMaxHeight().padding(horizontal = 24.dp, vertical = 18.dp)
                .panel(22.dp).padding(start = 30.dp, end = 30.dp, top = 22.dp, bottom = 22.dp),
        ) {
            Head(business, steps, step, f)
            Spacer(Modifier.height(10.dp))
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val where = at
                if (f == null || where == null) Reading(business)
                else AnimatedContent(
                    targetState = where,
                    transitionSpec = {
                        // the new one comes in from the side it lies on
                        fun place(name: String) = steps.indexOfFirst { it.name == name }.let { if (it < 0) steps.size else it }
                        val forward = place(targetState) > place(initialState)
                        (slideInHorizontally(Motion.enter(280)) { w -> if (forward) w / 10 else -w / 10 } + fadeIn(Motion.enter(220)))
                            .togetherWith(slideOutHorizontally(Motion.exit(160)) { w -> if (forward) -w / 14 else w / 14 } + fadeOut(Motion.exit(120)))
                    },
                    label = "step",
                ) { shown ->
                    when (steps.firstOrNull { it.name == shown }) {
                        SetupStep.Menu -> MenuStep(vm, f, next)
                        SetupStep.Tables -> TablesStep(vm, f, next)
                        SetupStep.Printer -> PrinterStep(vm, f, next)
                        SetupStep.Company -> CompanyStep(vm, f, next)
                        SetupStep.Staff -> StaffStep(vm, f, next)
                        null -> Summary(f, business, open, steps, onStep = { go(it.name, fromSummary = true) }) {
                            if (open) vm.finish(onDone) else onDone()
                        }
                    }
                }
            }
        }
        // what the item and category sheets say when they have saved
        ToastHost()
    }
}

// The card's head: whose set-up it is, and how far along.
@Composable
private fun Head(business: String, steps: List<SetupStep>, step: SetupStep?, facts: SetupFacts?) {
    Row(Modifier.fillMaxWidth().height(38.dp), verticalAlignment = Alignment.CenterVertically) {
        // the name and the mark, as on the sign-in card before it
        Wordmark()
        Spacer(Modifier.width(16.dp))
        Box(Modifier.width(1.dp).height(18.dp).background(V.Stroke2))
        Spacer(Modifier.width(16.dp))
        T(if (business.isBlank()) "Set-up" else "Set up $business", 14.sp, 700, V.Text2, Modifier.weight(1f))
        if (step != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                steps.forEach { s -> Dot(done = facts?.let { SetupSteps.done(s, it) } == true, here = s == step) }
            }
            Spacer(Modifier.width(12.dp))
            T("${steps.indexOf(step) + 1} of ${steps.size}", 13.sp, 700, V.Text3)
        }
    }
}

// A step along the way: the one open is longer, a done one is green.
@Composable
private fun Dot(done: Boolean, here: Boolean) {
    val width by animateDpAsState(if (here) 24.dp else 9.dp, Motion.enter(260), label = "dot")
    Box(Modifier.width(width).height(9.dp).clip(RoundedCornerShape(5.dp)).background(if (here) V.Text else if (done) V.Ok else V.Stroke2))
}

@Composable
private fun Reading(business: String) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(Modifier.size(28.dp), color = V.Cyan, strokeWidth = 2.5.dp)
        T(if (business.isBlank()) "Reading what the business has" else "Reading what $business has", 14.sp, 500, V.Text2)
    }
}

// What is set up and what is left, a line a step. A tap does it, or changes it.
@Composable
private fun Summary(facts: SetupFacts, business: String, open: Boolean, steps: List<SetupStep>, onStep: (SetupStep) -> Unit, onLeave: () -> Unit) {
    val name = business.ifBlank { "The business" }
    StepBody(
        title = if (SetupSteps.done(SetupStep.Menu, facts)) "$name is ready to sell" else "$name has nothing to sell yet",
        sub = "What is set up, and what is left. Tap a line to do it, or to change it.",
        foot = { StepFoot(if (open) "Open the till" else "Back to the till", ready = true, busy = false, onMain = onLeave) },
    ) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.Well)) {
            steps.forEachIndexed { i, s ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                val done = SetupSteps.done(s, facts)
                Row(
                    Modifier.fillMaxWidth().press(0.99f) { onStep(s) }.padding(horizontal = 18.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier.size(26.dp).clip(CircleShape).then(if (done) Modifier.background(V.Ok) else Modifier.border(1.5.dp, V.Stroke2, CircleShape)),
                        contentAlignment = Alignment.Center,
                    ) { if (done) VIcon(VI.Check, 14.dp, Color.White, width = 2.6f) }
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(SetupSteps.title(s, facts.retail), 16.sp, 800)
                        T(SetupSteps.line(s, facts), 14.sp, 500, if (done) V.Text2 else V.AmberText, lines = 2, height = 19.sp)
                    }
                    Spacer(Modifier.width(12.dp))
                    T(if (done) "Change" else "Do it now", 14.sp, 700, V.BlueText)
                }
            }
        }
        val office = runCatching { java.net.URI(BuildConfig.BACK_OFFICE_URL.trim()).host }.getOrNull()?.takeIf { it.isNotBlank() }
        T(
            // what the tablet does not set: a shop has no add-ons and no plan
            (if (facts.retail) "Taxes, discounts, variants, costs, the receipt's logo and more printers are set in the back office"
            else "Taxes, discounts, add-ons, the receipt's logo, more printers and the plan's exact layout are set in the back office") + (office?.let { ": $it" } ?: "."),
            13.sp, 500, V.Text3, lines = 3, height = 19.sp,
        )
        T(if (facts.pins > 0) "Next: clock in, then open the day." else "Next: tap Open register.", 14.sp, 600, V.Text2)
    }
}

// ---- what every step is built from ----

// A step: its heading, what it holds (scrolling, with the keyboard up or
// without), and its foot, which stays where it is.
@Composable
internal fun StepBody(title: String, sub: String, foot: @Composable () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Heading(title, sub)
            content()
        }
        Spacer(Modifier.height(14.dp))
        foot()
    }
}

// A step's foot: its one main key, which says what is missing until it can be
// pressed, and a quiet way past it on the left.
@Composable
internal fun StepFoot(main: String, ready: Boolean, busy: Boolean, quiet: String? = null, onQuiet: () -> Unit = {}, onMain: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (quiet != null) QuietLink(quiet, enabled = !busy, onClick = onQuiet)
        Gap()
        MainKey(main, ready, busy, Modifier.width(360.dp), onMain)
    }
}

internal const val SKIP = "Skip for now"
