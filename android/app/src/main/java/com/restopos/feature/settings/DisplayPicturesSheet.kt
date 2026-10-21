package com.restopos.feature.settings

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.database.DisplayPictureEntity
import com.restopos.core.display.DisplayPictures
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import javax.inject.Inject

// Settings, Printers: the pictures a customer display shows in turn, picked
// from this tablet's photos: a Wi-Fi display's (by its row) or the cable
// screen's. Kept on this tablet, up to 5.
@HiltViewModel
class DisplayPicturesViewModel @Inject constructor(private val pictures: DisplayPictures) : ViewModel() {
    fun of(owner: String): Flow<List<DisplayPictureEntity>> = pictures.of(owner)
    fun add(owner: String, from: android.net.Uri) = viewModelScope.launch {
        pictures.add(owner, from).onFailure { Toaster.say(it.message?.takeIf { m -> m.length < 140 } ?: "That picture could not be used. Try another.") }
    }
    fun remove(id: String) = viewModelScope.launch { pictures.remove(id) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DisplayPicturesSheet(owner: String, name: String, vm: DisplayPicturesViewModel = hiltViewModel(), onClose: () -> Unit) {
    val flow = remember(owner) { vm.of(owner) }
    val rows by flow.collectAsState(emptyList())
    val choose = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> if (uri != null) vm.add(owner, uri) }
    Sheet(onClose, width = 640.dp) {
        SheetHead("Pictures on $name", "Shown in turn beside the sale and between sales, 8 seconds each. Up to ${DisplayPictures.MOST}, kept on this tablet.", onClose)
        if (rows.isEmpty()) T("No pictures yet: the logo and the business's name are shown alone.", 14.sp, 500, V.Text2, lines = 2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            rows.forEach { r ->
                val pic = remember(r.hash) { runCatching { BitmapFactory.decodeByteArray(r.jpeg, 0, r.jpeg.size)?.asImageBitmap() }.getOrNull() }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (pic != null) Image(pic, null, Modifier.width(180.dp).height(112.dp).clip(RoundedCornerShape(10.dp)).background(V.Well), contentScale = ContentScale.Crop)
                    VBtn("Take off", Modifier.width(180.dp), height = 40.dp) { vm.remove(r.id) }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (rows.size < DisplayPictures.MOST) VBtn("Add a picture", height = 48.dp, icon = VI.Plus) {
                runCatching { choose.launch("image/*") }.onFailure { Toaster.say("This tablet has no app to choose a picture with.") }
            }
            VBtn("Done", height = 48.dp, onClick = onClose)
        }
    }
}
