import { normalizeText } from "./utils.js";

export function getEventDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function getTodayInTimezone(timeZone = "UTC") {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find(p => p.type === "year")?.value;
  const month = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;

  return new Date(`${year}-${month}-${day}T00:00:00`);
}

export function resolveDateReference(analysis, timeZone) {
  const ref = normalizeText(analysis.date_reference || "");
  const startDate = getTodayInTimezone(timeZone || "UTC");

  if (ref === "hoy") return startDate;

  if (ref === "manana" || ref === "mañana") {
    const d = new Date(startDate);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const parsed = getEventDateTime(analysis.date_reference);
  if (parsed) return parsed;

  return null;
}

export function getTripStartDate(tripJson) {
  const flights = tripJson.flightReservations || [];

  for (const reservation of flights) {
    for (const segment of reservation.segments || []) {
      const date = segment.departureDate || segment.departureDateTime;
      if (date) return new Date(date);
    }
  }

  const hotels = tripJson.hotelVouchers || [];
  if (hotels.length > 0 && hotels[0].checkIn) return new Date(hotels[0].checkIn);

  return null;
}

export function collectTripEvents(tripJson) {
  const events = [];

  for (const reservation of tripJson.flightReservations || []) {
    for (const segment of reservation.segments || []) {
      events.push({
        type: "flight",
        title: `Vuelo ${segment.airlineCode || ""}${segment.flightNumber || ""} ${segment.departureAirport || ""} → ${segment.arrivalAirport || ""}`,
        start: getEventDateTime(segment.departureDate || segment.departureDateTime),
        end: getEventDateTime(segment.arrivalDate || segment.arrivalDateTime)
      });
    }
  }

  for (const service of tripJson.serviceBookings || []) {
    if (service.category === "activity" && service.activity) {
      const datePart = service.activity.date;
      const timePart = service.activity.time || "00:00";
      const dateOnly = datePart ? String(datePart).split("T")[0] : null;
      const start = dateOnly ? getEventDateTime(`${dateOnly}T${timePart}:00`) : null;

      events.push({ type: "activity", title: service.activity.activityName || "Actividad", start, end: start });
    }

    if (service.category === "transfer" && service.transfer) {
      const datePart = service.transfer.date;
      const timePart = service.transfer.pickupTime || "00:00";
      const dateOnly = datePart ? String(datePart).split("T")[0] : null;
      const start = dateOnly ? getEventDateTime(`${dateOnly}T${timePart}:00`) : null;

      events.push({
        type: "transfer",
        title: `Traslado ${service.transfer.pickupLocation || ""} → ${service.transfer.dropoffLocation || ""}`,
        start,
        end: start
      });
    }
  }

  return events.filter(e => e.start).sort((a, b) => a.start - b.start);
}

function requiredBufferMinutes(current, next) {
  if (next.type === "flight") return 180;
  if (current.type === "hotel_checkout" && next.type === "flight") return 180;
  if (next.type === "train") return 60;
  if (next.type === "activity") return 45;
  return 60;
}

export function detectBasicConflicts(tripJson) {
  const events = collectTripEvents(tripJson);
  const conflicts = [];

  for (let i = 0; i < events.length - 1; i++) {
    const current = events[i];
    const next = events[i + 1];
    const sameDay = current.start.toISOString().split("T")[0] === next.start.toISOString().split("T")[0];
    if (!sameDay) continue;

    const currentEnd = current.end || current.start;
    const minutesBetween = (next.start - currentEnd) / 60000;

    if (minutesBetween < 0) {
      conflicts.push({ severity: "high", type: "overlap", message: `Hay eventos encimados: "${current.title}" y "${next.title}".` });
    } else {
      const required = requiredBufferMinutes(current, next);
      if (minutesBetween < required) {
        conflicts.push({
          severity: minutesBetween < required / 2 ? "high" : "medium",
          type: "insufficient_buffer",
          message: `Tiempo insuficiente entre "${current.title}" y "${next.title}": hay ${Math.round(minutesBetween)} min disponibles y se recomiendan al menos ${required} min.`
        });
      }
    }
  }

  const byDay = {};
  for (const event of events) {
    const day = event.start.toISOString().split("T")[0];
    byDay[day] = byDay[day] || [];
    byDay[day].push(event);
  }

  for (const [day, dayEvents] of Object.entries(byDay)) {
    if (dayEvents.length >= 4) {
      conflicts.push({ severity: "low", type: "busy_day", message: `El día ${day} tiene ${dayEvents.length} eventos. Puede sentirse cargado.` });
    }
  }

  return conflicts;
}

export function buildTripSummaryForClassifier(tripJson) {
  return {
    trip: tripJson.trip || {},
    hotels: (tripJson.hotelVouchers || []).map(h => ({
      name: h.accommodationName || h.hotelName || h.name || null,
      address: h.accommodationAddress || h.address || null,
      checkIn: h.checkIn || null,
      checkOut: h.checkOut || null,
      city: h.city || h.destination || null
    })),
    flights: (tripJson.flightReservations || []).flatMap(r =>
      (r.segments || []).map(s => ({
        departureAirport: s.departureAirport || null,
        arrivalAirport: s.arrivalAirport || null,
        departureDate: s.departureDate || s.departureDateTime || null,
        arrivalDate: s.arrivalDate || s.arrivalDateTime || null,
        airlineCode: s.airlineCode || null,
        flightNumber: s.flightNumber || null
      }))
    ),
    services: (tripJson.serviceBookings || []).map(s => ({
      category: s.category || null,
      name: s.activity?.activityName || s.transfer?.pickupLocation || s.serviceName || null,
      location: s.location || s.activity?.location || s.transfer?.pickupLocation || s.transfer?.dropoffLocation || null,
      date: s.activity?.date || s.transfer?.date || null
    }))
  };
}

export function buildTripTimelineForClassifier(tripJson) {
  const items = [];

  for (const hotel of tripJson.hotelVouchers || []) {
    items.push({
      type: "hotel",
      name: hotel.accommodationName || hotel.hotelName || hotel.name || null,
      address: hotel.accommodationAddress || hotel.address || null,
      city: hotel.city || hotel.destination || hotel.accommodationCity || null,
      checkIn: hotel.checkIn || null,
      checkOut: hotel.checkOut || null,
      raw: hotel
    });
  }

  for (const reservation of tripJson.flightReservations || []) {
    for (const segment of reservation.segments || []) {
      items.push({
        type: "flight",
        title: `Vuelo ${segment.airlineCode || ""}${segment.flightNumber || ""}`,
        departureAirport: segment.departureAirport || null,
        arrivalAirport: segment.arrivalAirport || null,
        departureDate: segment.departureDate || segment.departureDateTime || null,
        arrivalDate: segment.arrivalDate || segment.arrivalDateTime || null,
        raw: segment
      });
    }
  }

  for (const service of tripJson.serviceBookings || []) {
    if (service.category === "transfer" && service.transfer) {
      items.push({
        type: "transfer",
        pickupLocation: service.transfer.pickupLocation || null,
        dropoffLocation: service.transfer.dropoffLocation || null,
        date: service.transfer.date || null,
        pickupTime: service.transfer.pickupTime || null,
        raw: service
      });
    }

    if (service.category === "activity" && service.activity) {
      items.push({
        type: "activity",
        name: service.activity.activityName || null,
        location: service.activity.location || service.location || null,
        date: service.activity.date || null,
        time: service.activity.time || null,
        raw: service
      });
    }
  }

  return items.sort((a, b) => {
    const aDate = a.departureDate || a.arrivalDate || a.checkIn || a.checkOut || a.date || "";
    const bDate = b.departureDate || b.arrivalDate || b.checkIn || b.checkOut || b.date || "";
    return String(aDate).localeCompare(String(bDate));
  });
}

export function buildContextByIntent(tripJson, analysis, timeZone) {
  const intent = analysis.intent || "general";
  const scope = analysis.scope || "all";
  const city = normalizeText(analysis.city || "");

  const base = { trip: tripJson.trip || {}, metadata: tripJson.metadata || {} };
  const date = resolveDateReference(analysis, timeZone);

  if (date) {
    const dateStr = date.toISOString().split("T")[0];
    const filtered = {
      ...base,
      flightReservations: (tripJson.flightReservations || []).filter(f => JSON.stringify(f).includes(dateStr)),
      hotelVouchers: (tripJson.hotelVouchers || []).filter(h => JSON.stringify(h).includes(dateStr)),
      serviceBookings: (tripJson.serviceBookings || []).filter(s => JSON.stringify(s).includes(dateStr))
    };

    const hasResults = filtered.flightReservations.length || filtered.hotelVouchers.length || filtered.serviceBookings.length;
    if (hasResults) return filtered;

    const tripStart = getTripStartDate(tripJson);
    if (tripStart && date < tripStart) {
      return {
        ...base,
        note: "El viaje aún no comienza",
        requested_date: dateStr,
        trip_start: tripStart.toISOString(),
        flightReservations: tripJson.flightReservations || [],
        hotelVouchers: tripJson.hotelVouchers || [],
        serviceBookings: tripJson.serviceBookings || []
      };
    }

    return {
      ...base,
      note: "No hay actividades específicas para esta fecha",
      requested_date: dateStr,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: tripJson.hotelVouchers || [],
      serviceBookings: tripJson.serviceBookings || []
    };
  }

  if (scope === "city" && city) {
    const matchesCity = text => normalizeText(text).includes(city);
    return {
      ...base,
      flightReservations: tripJson.flightReservations || [],
      hotelVouchers: (tripJson.hotelVouchers || []).filter(h =>
        matchesCity(h.accommodationAddress) || matchesCity(h.accommodationName) || matchesCity(JSON.stringify(h))
      ),
      serviceBookings: (tripJson.serviceBookings || []).filter(s =>
        matchesCity(s.location) || matchesCity(JSON.stringify(s))
      )
    };
  }

  if (intent === "hotel") return { ...base, hotelVouchers: tripJson.hotelVouchers || [] };
  if (intent === "flight") return { ...base, flightReservations: tripJson.flightReservations || [] };
  if (intent === "activity") return { ...base, serviceBookings: (tripJson.serviceBookings || []).filter(s => s.category === "activity") };
  if (intent === "transfer") return { ...base, serviceBookings: (tripJson.serviceBookings || []).filter(s => s.category === "transfer") };

  return {
    ...base,
    flightReservations: tripJson.flightReservations || [],
    hotelVouchers: tripJson.hotelVouchers || [],
    serviceBookings: tripJson.serviceBookings || []
  };
}
