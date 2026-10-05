package com.restopos.core.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

// The till's own words in English, French and Kreol Morisien (the side menu's
// Language key). Menu items, order types and everything else the restaurant
// typed in the back office stay as they were typed.
// The Kreol follows the official spelling (Lortograf Kreol Morisien) as best
// it could be written here; it is waiting for someone who speaks it daily to
// read it through.
object L {
    // "en", "fr" or "mfe" (Kreol Morisien)
    var lang by mutableStateOf("en")
    // dates and the like follow French for French and for Kreol
    val fr: Boolean get() = lang == "fr" || lang == "mfe"
    fun t(en: String, french: String, kreol: String): String = when (lang) { "fr" -> french; "mfe" -> kreol; else -> en }

    val tables get() = t("Tables", "Salle", "Latab")
    val quick get() = t("Quick sale", "Vente rapide", "Lavant rapid")
    val takeaway get() = t("Takeaway", "À emporter", "Pou anporte")
    val kitchen get() = t("Kitchen", "Cuisine", "Lakwizinn")
    val bookings get() = t("Bookings", "Réserv.", "Rezervasion")
    val orders get() = t("Orders", "Commandes", "Komand")
    val today get() = t("Today’s sales", "Ventes du jour", "Lavant zordi")
    val todayTitle get() = t("Today", "Rapports", "Zordi")
    val menuStock get() = t("Menu & stock", "Carte & stock", "Meni & stok")
    val menu get() = t("Menu", "Carte", "Meni")
    val cashDrawer get() = t("Cash drawer", "Caisse", "Tirwar kes")
    val receipts get() = t("Receipts", "Reçus", "Resi")
    val customers get() = t("Customers", "Clients", "Klian")
    val settings get() = t("Settings", "Réglages", "Reglaz")
    val service get() = t("Service", "Service", "Servis")
    val backOffice get() = t("Back office", "Gestion", "Zestion")
    val language get() = t("Language", "Langue", "Lang")
    val switchStaff get() = t("Switch staff", "Changer d’utilisateur", "Sanz staf")
    val lock get() = t("Lock the till", "Verrouiller", "Lok lakes")

    val send get() = t("Send to kitchen", "Envoyer en cuisine", "Avoy lakwizinn")
    val pay get() = t("Pay", "Encaisser", "Peye")
    val charge get() = t("Charge", "Encaisser", "Ankese")
    val newTakeaway get() = t("New takeaway", "Nouvelle commande", "Nouvo komand")
    val newDelivery get() = t("New delivery", "Nouvelle livraison", "Nouvo livrezon")
    val delivery get() = t("Delivery", "Livraison", "Livrezon")
    val free get() = t("Free", "Libre", "Lib")
    val seated get() = t("Seated", "Occupée", "Okipe")
    val billAsked get() = t("Bill asked", "Addition", "Bil demande")
    val reserved get() = t("Reserved", "Réservée", "Rezerve")
    val openOrder get() = t("Open order", "Ouvrir", "Ouver komand")
    val total get() = t("Total", "Total", "Total")
    val subtotal get() = t("Subtotal", "Sous-total", "Sou-total")
    val serviceCharge get() = t("Service", "Service", "Servis")
    val discount get() = t("Discount", "Remise", "Rabe")
    val empty get() = t("Tap items to start the order", "Touchez un article pour commencer", "Tap lor enn artik pou koumans komand")
    val printBill get() = t("Print bill", "Addition", "Inprim bil")
    val newSale get() = t("New sale", "Nouvelle vente", "Nouvo lavant")
    val split get() = t("Split", "Diviser", "Partaz")
    val clearNew get() = t("Clear new", "Effacer", "Efase")
    val more get() = t("More", "Plus", "Plis")
    val openOrders get() = t("Open orders", "Commandes en cours", "Komand ouver")
    val arriving get() = t("Arriving next", "Prochaines arrivées", "Pe vini")
    val howMany get() = t("How many guests?", "Combien de couverts ?", "Komie dimounn?")
    val covers get() = t("covers", "couverts", "dimounn")
    val search get() = t("Search the menu", "Chercher dans la carte", "Rod dan meni")
    val inKitchen get() = t("In the kitchen", "En cuisine", "Dan lakwizinn")
    val notSent get() = t("New · not sent", "Nouveau · non envoyé", "Nouvo · pankor avoye")
    val remove get() = t("Remove", "Retirer", "Tire")
    val lunch get() = t("Lunch service", "Service du midi", "Servis midi")
    val dinner get() = t("Dinner service", "Service du soir", "Servis aswar")
}
