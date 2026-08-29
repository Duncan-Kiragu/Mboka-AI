/**
 * Buyer marketplace (P5).
 * Dedicated page: /feed.html and /feed.html?id=<listingId>
 * Embed on index.html: compact feed; card tap opens the listing page.
 * After a new post, P4 should call window.MbokaFeed.refresh().
 */
(function () {
  "use strict";

  var FILTERS = ["all", "furniture", "clothing", "food", "services", "electronics", "other"];
  var CHANNEL_LABEL = { web: "Web", call: "Phone call", ussd: "USSD" };
  var CHANNEL_SW = { web: "Sauti", call: "Simu", ussd: "USSD" };
  var CHANNEL_EN = { web: "Spoken", call: "Called in", ussd: "Basic phone" };
  var CAT_SW = {
    all: "Zote",
    furniture: "Mbao",
    clothing: "Nguo",
    food: "Chakula",
    services: "Huduma",
    electronics: "Elektroni",
    other: "Nyingine"
  };
  var PHONE_KEY = "mboka-phone";
  var POLL_MS = 12000;

  var isBuyer = document.body.getAttribute("data-page") === "buyer";
  var feedEl = document.getElementById("feed");
  var filtersEl = document.getElementById("filters");
  var locationFilter = document.getElementById("locationFilter");
  var myPhone = document.getElementById("myPhone");
  var tabAll = document.getElementById("tabAll");
  var tabMine = document.getElementById("tabMine");
  var searchQuery = document.getElementById("searchQuery");
  var feedCount = document.getElementById("feedCount");
  var feedUpdated = document.getElementById("feedUpdated");
  var feedView = document.getElementById("feedView");
  var detailView = document.getElementById("detailView");
  var detailPage = document.getElementById("detailPage");
  var toastEl = document.getElementById("toast");

  if (!feedEl || !filtersEl || !locationFilter) return;

  var allListings = [];
  var activeFilter = "all";
  var activeLocation = "all";
  var showMine = false;
  var openListing = null;
  var playingAudio = null;
  var knownIds = "";
  var pollTimer = 0;
  var toastTimer = 0;

  function digits(phone) {
    return String(phone || "").replace(/\D/g, "");
  }
  function samePhone(a, b) {
    var da = digits(a);
    var db = digits(b);
    return da === db && da.length >= 9;
  }
  function telHref(phone) {
    return digits(phone) ? "tel:" + phone : "";
  }
  function waHref(phone) {
    var n = digits(phone);
    if (!n) return "";
    if (n.charAt(0) === "0" && n.length === 10) n = "254" + n.slice(1);
    else if (n.length === 9) n = "254" + n;
    return "https://wa.me/" + n;
  }
  function formatPrice(price) {
    if (price === 0) return "KSh 0";
    if (price === null || price === undefined || price === "") return "Price on request";
    var n = Number(price);
    if (!isFinite(n)) return "KSh " + price;
    return "KSh " + n.toLocaleString("en-KE");
  }
  function channelLabel(channel) {
    return CHANNEL_LABEL[channel] || channel || "Unknown";
  }
  function originMark(channel) {
    var wrap = document.createElement("span");
    var key = CHANNEL_SW[channel] ? channel : "web";
    wrap.className = "origin origin-" + key;
    wrap.title = CHANNEL_EN[key] || channelLabel(channel);
    var sw = document.createElement("span");
    sw.className = "sw";
    sw.textContent = CHANNEL_SW[key] || channelLabel(channel);
    var en = document.createElement("span");
    en.className = "en";
    en.textContent = CHANNEL_EN[key] || channelLabel(channel);
    wrap.appendChild(sw);
    wrap.appendChild(en);
    return wrap;
  }
  function timeAgo(iso) {
    if (!iso) return "";
    var mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (!isFinite(mins) || mins < 1) return "Just now";
    if (mins < 60) return mins + " min ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }
  function fieldValue(value, fallback) {
    var text = String(value == null ? "" : value).trim();
    return text || fallback || "Not set";
  }
  function priceEmpty(price) {
    return price === null || price === undefined || price === "";
  }
  function hasMedia(url) {
    return typeof url === "string" && url.trim().length > 0;
  }
  function photoPlaceholder(listing) {
    var el = document.createElement("div");
    el.className = "photo-ph";
    el.setAttribute("aria-hidden", "true");
    el.textContent = String(listing.category || "M").charAt(0).toUpperCase();
    return el;
  }
  function thumbEl(listing) {
    var wrap = document.createElement("div");
    wrap.className = "thumb";
    if (listing.photo_url) {
      var img = document.createElement("img");
      img.src = listing.photo_url;
      img.alt = "";
      wrap.appendChild(img);
    } else {
      wrap.appendChild(photoPlaceholder(listing));
    }
    return wrap;
  }
  function listingHref(id) {
    return "/feed.html?id=" + encodeURIComponent(id);
  }
  function queryId() {
    try {
      return new URLSearchParams(location.search).get("id") || "";
    } catch (e) {
      return "";
    }
  }
  function confirmationSummary(listing) {
    var item = listing.item || "bidhaa";
    var parts = ["Umeongeza: " + item];
    if (!priceEmpty(listing.price)) parts.push("KSh " + listing.price);
    if (listing.location) parts.push(listing.location);
    return parts.join(", ") + ". Sawa?";
  }

  function coreMissingPrompt(listing) {
    var gaps = [];
    if (!String(listing.item || "").trim()) gaps.push("item");
    if (priceEmpty(listing.price)) gaps.push("price");
    if (!String(listing.location || "").trim()) gaps.push("location");
    if (!gaps.length) return "";
    var list = gaps.length === 1
      ? gaps[0]
      : gaps.slice(0, -1).join(", ") + " and " + gaps[gaps.length - 1];
    var verb = gaps.length === 1 ? " wasn't " : " weren't ";
    return list.charAt(0).toUpperCase() + list.slice(1) + verb +
      "captured on this listing. Ask the seller when you call.";
  }

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2800);
  }

  function stopAudio() {
    if (!playingAudio) return;
    try { playingAudio.pause(); } catch (e) {}
    playingAudio = null;
  }

  function bindAudio(audio) {
    audio.addEventListener("play", function () {
      if (playingAudio && playingAudio !== audio) {
        try { playingAudio.pause(); } catch (e) {}
      }
      playingAudio = audio;
    });
  }

  function listingUrl(id, replace, fromFeed) {
    var next = id ? listingHref(id) : "/feed.html";
    if (!isBuyer) {
      location.href = next;
      return;
    }
    var state = { id: id || "", fromFeed: !!fromFeed };
    if (replace) history.replaceState(state, "", next);
    else history.pushState(state, "", next);
  }

  function visibleListings() {
    var phone = myPhone ? myPhone.value.trim() : "";
    var q = searchQuery ? searchQuery.value.trim().toLowerCase() : "";
    return allListings.filter(function (l) {
      if (showMine && !samePhone(l.contact, phone)) return false;
      if (activeFilter !== "all" && l.category !== activeFilter) return false;
      if (activeLocation !== "all" && l.location !== activeLocation) return false;
      if (q) {
        var blob = [l.item, l.location, l.extra_notes, l.category, l.condition, l.source_channel]
          .join(" ")
          .toLowerCase();
        if (blob.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderFilters() {
    filtersEl.innerHTML = "";
    FILTERS.forEach(function (name) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = (CAT_SW[name] || name) + (name === "all" ? "" : " · " + name);
      if (name === activeFilter) btn.className = "active";
      btn.addEventListener("click", function () {
        activeFilter = name;
        renderFilters();
        renderFeed();
      });
      filtersEl.appendChild(btn);
    });
  }

  function renderLocationFilter() {
    var seen = {};
    var names = [];
    allListings.forEach(function (l) {
      if (l.location && !seen[l.location]) {
        seen[l.location] = true;
        names.push(l.location);
      }
    });
    names.sort();
    var previous = activeLocation;
    locationFilter.innerHTML = "";
    var allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "Eneo lote · All areas";
    locationFilter.appendChild(allOpt);
    names.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      locationFilter.appendChild(opt);
    });
    activeLocation = names.indexOf(previous) >= 0 ? previous : "all";
    locationFilter.value = activeLocation;
  }

  function addContactRow(parent, listing, stopCard) {
    var contacts = document.createElement("div");
    contacts.className = "contacts";
    var call = telHref(listing.contact);
    var wa = waHref(listing.contact);
    if (call) {
      var callA = document.createElement("a");
      callA.href = call;
      callA.textContent = "Call";
      contacts.appendChild(callA);
    }
    if (wa) {
      var waA = document.createElement("a");
      waA.href = wa;
      waA.target = "_blank";
      waA.rel = "noopener";
      waA.textContent = "WhatsApp";
      contacts.appendChild(waA);
    }
    var mine = myPhone && samePhone(listing.contact, myPhone.value.trim()) && listing.status === "active";
    if (mine) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Mark sold";
      btn.addEventListener("click", function (e) {
        if (stopCard) e.stopPropagation();
        markSold(listing.id);
      });
      contacts.appendChild(btn);
    }
    if (contacts.childNodes.length) parent.appendChild(contacts);
    return contacts;
  }

  function renderCard(listing, index) {
    var weight = index === 0 ? "is-lead" : index < 3 ? "is-mid" : "is-rest";
    var card = document.createElement("article");
    card.className = (isBuyer ? "listing-row " + weight : "card") + (listing.status === "sold" ? " sold" : "");
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", (listing.item || "Listing") + ". Open listing");

    if (isBuyer) {
      card.appendChild(thumbEl(listing));
      var copy = document.createElement("div");
      copy.className = "copy";
      copy.appendChild(originMark(listing.source_channel));
      var price = document.createElement("p");
      price.className = "price";
      price.textContent = formatPrice(listing.price);
      var item = document.createElement("p");
      item.className = "item";
      item.textContent = listing.item || "Untitled";
      var meta = document.createElement("div");
      meta.className = "meta";
      var bits = [
        listing.location || "Location not set",
        timeAgo(listing.created_at),
        listing.category || "other"
      ];
      if (listing.status === "sold") bits.push("sold");
      meta.textContent = bits.join(" · ");
      copy.appendChild(price);
      copy.appendChild(item);
      copy.appendChild(meta);
      card.appendChild(copy);
      var foot = document.createElement("div");
      foot.className = "card-foot";
      addContactRow(foot, listing, true);
      card.appendChild(foot);
    } else {
      if (listing.photo_url) {
        var img = document.createElement("img");
        img.src = listing.photo_url;
        img.alt = "";
        card.appendChild(img);
      }
      card.appendChild(originMark(listing.source_channel));
      var itemEl = document.createElement("div");
      itemEl.className = "item";
      itemEl.textContent = listing.item || "Untitled";
      card.appendChild(itemEl);
      var metaEl = document.createElement("div");
      metaEl.className = "meta";
      var priceEl = document.createElement("span");
      priceEl.textContent = formatPrice(listing.price);
      var locEl = document.createElement("span");
      locEl.textContent = listing.location || "Location not set";
      var pillEl = document.createElement("span");
      pillEl.className = "pill";
      pillEl.textContent = listing.category || "other";
      metaEl.appendChild(priceEl);
      metaEl.appendChild(locEl);
      metaEl.appendChild(pillEl);
      if (listing.condition) {
        var cond = document.createElement("span");
        cond.textContent = listing.condition;
        metaEl.appendChild(cond);
      }
      if (listing.status === "sold") {
        var soldEl = document.createElement("span");
        soldEl.className = "pill";
        soldEl.textContent = "sold";
        metaEl.appendChild(soldEl);
      }
      card.appendChild(metaEl);
      var compactFoot = document.createElement("div");
      compactFoot.className = "card-foot";
      addContactRow(compactFoot, listing, true);
      card.appendChild(compactFoot);
    }

    card.addEventListener("click", function (e) {
      if (e.target.closest(".contacts")) return;
      openListingPage(listing);
    });
    card.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openListingPage(listing);
      }
    });
    return card;
  }

  function renderFeed() {
    var rows = visibleListings();
    feedEl.innerHTML = "";
    if (feedCount) {
      feedCount.textContent = rows.length === 1
        ? "1 listing"
        : rows.length + " listings";
    }
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = showMine
        ? (myPhone && myPhone.value.trim()
          ? "No listings for this phone yet."
          : "Enter your phone, then open Mine.")
        : (searchQuery && searchQuery.value.trim()
          ? "No listings match that search."
          : "No listings in this filter yet.");
      feedEl.appendChild(empty);
      return;
    }
    rows.forEach(function (listing, index) {
      feedEl.appendChild(renderCard(listing, index));
    });
  }

  function showFeedView() {
    stopAudio();
    openListing = null;
    if (feedView) feedView.hidden = false;
    if (detailView) detailView.hidden = true;
    document.title = "Mboka — Soko";
  }

  function showDetailView() {
    if (feedView) feedView.hidden = true;
    if (detailView) detailView.hidden = false;
    window.scrollTo(0, 0);
  }

  function renderNotFound() {
    if (!detailPage) return;
    showDetailView();
    detailPage.innerHTML = "";
    var box = document.createElement("div");
    box.className = "not-found";
    var h = document.createElement("h2");
    h.textContent = "Listing not found";
    var p = document.createElement("p");
    p.textContent = "It may have been removed, or the live server restarted and lost in-memory posts.";
    var back = document.createElement("button");
    back.type = "button";
    back.className = "icon-btn";
    back.textContent = "Back to soko";
    back.addEventListener("click", closeDetail);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(back);
    detailPage.appendChild(box);
    document.title = "Listing not found — Mboka";
    openListing = null;
  }

  function renderDetailLoading() {
    if (!detailPage) return;
    showDetailView();
    detailPage.innerHTML = "";
    var sk = document.createElement("div");
    sk.className = "sk-card";
    sk.style.height = "420px";
    detailPage.appendChild(sk);
  }

  function paintWave(canvas, buffer) {
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var w = canvas.width;
    var h = canvas.height;
    ctx.fillStyle = "#1a1008";
    ctx.fillRect(0, 0, w, h);
    var data = buffer.getChannelData(0);
    var step = Math.max(1, Math.floor(data.length / w));
    ctx.strokeStyle = "#e24a16";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var x = 0; x < w; x++) {
      var min = 1;
      var max = -1;
      var start = x * step;
      for (var i = 0; i < step && start + i < data.length; i++) {
        var v = data[start + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      var y1 = (1 - max) * 0.5 * h;
      var y2 = (1 - min) * 0.5 * h;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
  }

  function attachWaveform(parent, audioEl) {
    var wrap = document.createElement("div");
    wrap.className = "wave-wrap";
    var canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 72;
    canvas.setAttribute("aria-hidden", "true");
    var play = document.createElement("button");
    play.type = "button";
    play.className = "wave-play";
    play.textContent = "Sikiliza";
    play.addEventListener("click", function () {
      if (audioEl.paused) {
        audioEl.play().catch(function () {});
        play.textContent = "Simama";
      } else {
        audioEl.pause();
        play.textContent = "Sikiliza";
      }
    });
    audioEl.addEventListener("ended", function () { play.textContent = "Sikiliza"; });
    wrap.appendChild(canvas);
    wrap.appendChild(play);
    parent.appendChild(wrap);
    var src = audioEl.src;
    if (!src) return;
    fetch(src)
      .then(function (res) { return res.arrayBuffer(); })
      .then(function (ab) {
        var ac = new (window.AudioContext || window.webkitAudioContext)();
        return ac.decodeAudioData(ab);
      })
      .then(function (buffer) { paintWave(canvas, buffer); })
      .catch(function () {});
  }

  function addAudioBlock(parent, listing) {
    var box = document.createElement("div");
    box.className = "listen";
    var h = document.createElement("h2");
    h.innerHTML = '<span class="sw">Sauti ya muuzaji</span><span class="en">Listen</span>';
    box.appendChild(h);
    if (hasMedia(listing.audio_url)) {
      var audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = listing.audio_url;
      bindAudio(audio);
      attachWaveform(box, audio);
      box.appendChild(audio);
    }
    if (hasMedia(listing.narration_url)) {
      var narrated = document.createElement("audio");
      narrated.controls = true;
      narrated.preload = "metadata";
      narrated.src = listing.narration_url;
      bindAudio(narrated);
      box.appendChild(narrated);
    } else {
      var play = document.createElement("button");
      play.type = "button";
      play.textContent = hasMedia(listing.audio_url) ? "Play voice summary" : "Hear this listing";
      play.addEventListener("click", function () { speakListing(listing, play); });
      box.appendChild(play);
    }
    parent.appendChild(box);
  }

  async function speakListing(listing, button) {
    button.disabled = true;
    button.textContent = "Loading voice…";
    try {
      var res = await fetch("/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: confirmationSummary(listing) })
      });
      if (!res.ok) throw new Error("speak failed");
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var audio = document.createElement("audio");
      audio.controls = true;
      audio.src = url;
      bindAudio(audio);
      button.replaceWith(audio);
      var playAttempt = audio.play();
      if (playAttempt && playAttempt.catch) playAttempt.catch(function () {});
    } catch (err) {
      button.disabled = false;
      button.textContent = "Voice unavailable — try again";
    }
  }

  function renderDetail(listing) {
    if (!detailPage) return;
    openListing = listing;
    showDetailView();
    detailPage.innerHTML = "";
    document.title = (listing.item || "Listing") + " — Mboka";

    var page = document.createElement("article");
    page.className = "listing";

    var nav = document.createElement("div");
    nav.className = "listing-nav";
    var back = document.createElement("button");
    back.type = "button";
    back.textContent = "← Soko";
    back.addEventListener("click", closeDetail);
    var share = document.createElement("button");
    share.type = "button";
    share.textContent = "Share";
    share.addEventListener("click", function () {
      var url = location.origin + listingHref(listing.id);
      if (navigator.share) {
        navigator.share({ title: listing.item || "Mboka listing", url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { toast("Link copied"); }).catch(function () {});
      }
    });
    nav.appendChild(back);
    nav.appendChild(share);
    page.appendChild(nav);

    var photo = document.createElement("div");
    photo.className = "listing-photo";
    if (listing.photo_url) {
      var img = document.createElement("img");
      img.src = listing.photo_url;
      img.alt = listing.item || "";
      photo.appendChild(img);
    } else {
      photo.appendChild(photoPlaceholder(listing));
    }
    page.appendChild(photo);

    var body = document.createElement("div");
    body.className = "listing-body";

    var price = document.createElement("p");
    price.className = "listing-price";
    price.textContent = formatPrice(listing.price);
    var title = document.createElement("h1");
    title.className = "listing-title";
    title.textContent = listing.item || "Untitled";
    var meta = document.createElement("p");
    meta.className = "listing-meta";
    meta.textContent = [
      listing.location || "Location not set",
      timeAgo(listing.created_at),
      "via " + channelLabel(listing.source_channel)
    ].join(" · ");
    body.appendChild(price);
    body.appendChild(title);
    body.appendChild(originMark(listing.source_channel));
    body.appendChild(meta);

    var chips = document.createElement("div");
    chips.className = "listing-chips";
    [listing.category || "other", listing.condition].forEach(function (label) {
      if (!label) return;
      var pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = label;
      chips.appendChild(pill);
    });
    if (listing.status === "sold") {
      var sold = document.createElement("span");
      sold.className = "pill sold";
      sold.textContent = "sold";
      chips.appendChild(sold);
    }
    if (chips.childNodes.length) body.appendChild(chips);

    var missing = coreMissingPrompt(listing);
    if (missing) {
      var prompt = document.createElement("p");
      prompt.className = "extract-prompt";
      prompt.textContent = missing;
      body.appendChild(prompt);
    }

    var facts = document.createElement("dl");
    facts.className = "facts";
    [
      ["Location", fieldValue(listing.location, "Not set")],
      ["Category", fieldValue(listing.category, "other")],
      ["Condition", fieldValue(listing.condition, "Not set")]
    ].forEach(function (pair) {
      var fact = document.createElement("div");
      fact.className = "fact" + (pair[1] === "Not set" ? " blank" : "");
      var dt = document.createElement("dt");
      dt.textContent = pair[0];
      var dd = document.createElement("dd");
      dd.textContent = pair[1];
      fact.appendChild(dt);
      fact.appendChild(dd);
      facts.appendChild(fact);
    });
    body.appendChild(facts);

    var about = document.createElement("div");
    about.className = "about";
    var aboutH = document.createElement("h2");
    aboutH.textContent = "About this listing";
    var aboutP = document.createElement("p");
    var notes = String(listing.extra_notes || "").trim();
    aboutP.textContent = notes || listing.item || "No extra notes.";
    if (!notes) aboutP.className = "muted";
    about.appendChild(aboutH);
    about.appendChild(aboutP);
    body.appendChild(about);

    addAudioBlock(body, listing);
    page.appendChild(body);
    detailPage.appendChild(page);

    var cta = document.createElement("div");
    cta.className = "cta";
    var call = telHref(listing.contact);
    var wa = waHref(listing.contact);
    if (call) {
      var callA = document.createElement("a");
      callA.className = "call";
      callA.href = call;
      callA.textContent = "Call";
      cta.appendChild(callA);
    }
    if (wa) {
      var waA = document.createElement("a");
      waA.className = "wa";
      waA.href = wa;
      waA.target = "_blank";
      waA.rel = "noopener";
      waA.textContent = "WhatsApp";
      cta.appendChild(waA);
    }
    var mine = myPhone && samePhone(listing.contact, myPhone.value.trim()) && listing.status === "active";
    if (mine) {
      var soldBtn = document.createElement("button");
      soldBtn.type = "button";
      soldBtn.textContent = "Mark sold";
      soldBtn.addEventListener("click", function () { markSold(listing.id); });
      cta.appendChild(soldBtn);
    }
    if (cta.childNodes.length) detailPage.appendChild(cta);
  }

  function closeDetail() {
    stopAudio();
    if (isBuyer && queryId() && history.state && history.state.fromFeed) {
      history.back();
      return;
    }
    showFeedView();
    if (isBuyer && queryId()) listingUrl("", true, false);
  }

  function openListingPage(listing) {
    if (!listing) return;
    if (!isBuyer) {
      location.href = listingHref(listing.id);
      return;
    }
    if (queryId() !== listing.id) listingUrl(listing.id, false, true);
    renderDetail(listing);
    fetchListing(listing.id, false);
  }

  async function fetchListing(id, showLoading) {
    if (!id) return null;
    if (showLoading) renderDetailLoading();
    try {
      var res = await fetch("/listings/" + encodeURIComponent(id));
      if (res.status === 404) {
        renderNotFound();
        return null;
      }
      if (!res.ok) throw new Error("bad listing");
      var listing = await res.json();
      renderDetail(listing);
      return listing;
    } catch (err) {
      if (showLoading) {
        renderNotFound();
      }
      return null;
    }
  }

  async function markSold(id) {
    try {
      var res = await fetch("/listings/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "sold" })
      });
      if (!res.ok) {
        toast("Could not mark as sold");
        return;
      }
      await loadListings(true);
      if (openListing && openListing.id === id) {
        var updated = allListings.filter(function (row) { return row.id === id; })[0];
        if (updated) renderDetail(updated);
      }
    } catch (e) {
      toast("Could not mark as sold");
    }
  }

  function showSkeletons() {
    if (allListings.length) return;
    feedEl.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var sk = document.createElement("div");
      sk.className = "sk-card";
      feedEl.appendChild(sk);
    }
  }

  async function loadListings(silent) {
    if (!silent) showSkeletons();
    try {
      var res = await fetch("/listings");
      if (!res.ok) throw new Error("feed failed");
      var rows = await res.json();
      if (!Array.isArray(rows)) rows = [];
      var nextIds = rows.map(function (row) { return row.id; }).join(",");
      if (knownIds && nextIds !== knownIds && rows.length >= allListings.length) {
        toast("Feed updated");
      }
      knownIds = nextIds;
      allListings = rows;
      renderLocationFilter();
      renderFeed();
      if (feedUpdated) feedUpdated.textContent = "Live";
    } catch (err) {
      if (!allListings.length) {
        feedEl.innerHTML = "";
        var panel = document.createElement("div");
        panel.className = "error-panel";
        panel.textContent = "Could not load the feed.";
        var retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry";
        retry.addEventListener("click", function () { loadListings(); });
        panel.appendChild(document.createElement("br"));
        panel.appendChild(retry);
        feedEl.appendChild(panel);
      }
    }
  }

  async function applyRoute() {
    var id = queryId();
    if (!isBuyer) return;
    if (!id) {
      showFeedView();
      return;
    }
    var cached = allListings.filter(function (row) { return row.id === id; })[0];
    if (cached) renderDetail(cached);
    await fetchListing(id, !cached);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (document.visibilityState !== "visible") return;
      loadListings(true);
    }, POLL_MS);
  }

  if (myPhone) {
    myPhone.value = localStorage.getItem(PHONE_KEY) || myPhone.value || "";
    myPhone.addEventListener("change", function () {
      localStorage.setItem(PHONE_KEY, myPhone.value.trim());
    });
    myPhone.addEventListener("input", function () {
      if (showMine) renderFeed();
    });
  }
  locationFilter.addEventListener("change", function () {
    activeLocation = locationFilter.value;
    renderFeed();
  });
  if (tabAll) {
    tabAll.addEventListener("click", function () {
      showMine = false;
      tabAll.className = "active";
      if (tabMine) tabMine.className = "";
      renderFeed();
    });
  }
  if (tabMine) {
    tabMine.addEventListener("click", function () {
      showMine = true;
      tabMine.className = "active";
      if (tabAll) tabAll.className = "";
      renderFeed();
    });
  }
  if (searchQuery) {
    searchQuery.addEventListener("input", function () { renderFeed(); });
  }
  window.addEventListener("popstate", function () { applyRoute(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") loadListings(true);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isBuyer && queryId()) closeDetail();
  });

  if (isBuyer) {
    history.replaceState({ id: queryId(), fromFeed: false }, "", location.href);
    if (queryId()) renderDetailLoading();
  }
  renderFilters();
  loadListings().then(function () { return applyRoute(); });
  startPolling();

  window.MbokaFeed = {
    refresh: function () { return loadListings(true); },
    open: function (id) {
      if (!id) return;
      if (isBuyer) {
        listingUrl(id, false, true);
        fetchListing(id, true);
      } else {
        location.href = listingHref(id);
      }
    },
    close: closeDetail
  };
})();
