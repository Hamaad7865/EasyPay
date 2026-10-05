package com.restopos.core.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

// The till's own words in English and French (the side menu's Language key).
// Menu items, order types and everything else the restaurant typed in the
// back office stay as they were typed.
object L {
    var fr by mutableStateOf(false)
    fun t(en: String, french: String): String = if (fr) french else en

    val tables get() = t("Tables", "Salle")
    val quick get() = t("Quick sale", "Vente rapide")
    val takeaway get() = t("Takeaway", "À emporter")
    val kitchen get() = t("Kitchen", "Cuisine")
    val bookings get() = t("Bookings", "Réserv.")
    val orders get() = t("Orders", "Commandes")
    val today get() = t("Today’s sales", "Ventes du jour")
    val todayTitle get() = t("Today", "Rapports")
    val menuStock get() = t("Menu & stock", "Carte & stock")
    val menu get() = t("Menu", "Carte")
    val cashDrawer get() = t("Cash drawer", "Caisse")
    val receipts get() = t("Receipts", "Reçus")
    val customers get() = t("Customers", "Clients")
    val settings get() = t("Settings", "Réglages")
    val service get() = t("Service", "Service")
    val backOffice get() = t("Back office", "Gestion")
    val language get() = t("Language", "Langue")
    val switchStaff get() = t("Switch staff", "Changer d’utilisateur")
    val lock get() = t("Lock the till", "Verrouiller")

    val send get() = t("Send to kitchen", "Envoyer en cuisine")
    val pay get() = t("Pay", "Encaisser")
    val charge get() = t("Charge", "Encaisser")
    val newTakeaway get() = t("New takeaway", "Nouvelle commande")
    val newDelivery get() = t("New delivery", "Nouvelle livraison")
    val delivery get() = t("Delivery", "Livraison")
    val free get() = t("Free", "Libre")
    val seated get() = t("Seated", "Occupée")
    val billAsked get() = t("Bill asked", "Addition")
    val reserved get() = t("Reserved", "Réservée")
    val openOrder get() = t("Open order", "Ouvrir")
    val total get() = t("Total", "Total")
    val subtotal get() = t("Subtotal", "Sous-total")
    val serviceCharge get() = t("Service", "Service")
    val discount get() = t("Discount", "Remise")
    val empty get() = t("Tap items to start the order", "Touchez un article pour commencer")
    val printBill get() = t("Print bill", "Addition")
    val split get() = t("Split", "Diviser")
    val clearNew get() = t("Clear new", "Effacer")
    val more get() = t("More", "Plus")
    val openOrders get() = t("Open orders", "Commandes en cours")
    val arriving get() = t("Arriving next", "Prochaines arrivées")
    val howMany get() = t("How many guests?", "Combien de couverts ?")
    val covers get() = t("covers", "couverts")
    val search get() = t("Search the menu", "Chercher dans la carte")
    val inKitchen get() = t("In the kitchen", "En cuisine")
    val notSent get() = t("New · not sent", "Nouveau · non envoyé")
    val remove get() = t("Remove", "Retirer")
    val lunch get() = t("Lunch service", "Service du midi")
    val dinner get() = t("Dinner service", "Service du soir")
}
