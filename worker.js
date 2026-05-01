export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Yompr Concierge funcionando 🚀");
    }

    if (url.pathname === "/admin") {
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8" />
          <title>Yompr Concierge Admin</title>
        </head>
        <body style="font-family: Arial; padding: 24px;">
          <h1>Yompr Concierge Admin</h1>
          <p>Sube aquí el JSON completo del viaje.</p>

          <textarea id="jsonInput" style="width:100%; height:300px;"></textarea>
          <br><br>
          <button onclick="uploadTrip()">Guardar viaje</button>

          <div id="result" style="margin-top:20px;"></div>

          <script>
            async function uploadTrip() {
              const jsonText = document.getElementById("jsonInput").value;

              const res = await fetch("/api/upload-trip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: jsonText
              });

              const data = await res.json();

              document.getElementById("result").innerHTML =
                "<p><b>Resultado:</b> " + data.message + "</p>" +
                (data.link ? '<p><a href="' + data.link + '" target="_blank">Abrir viaje</a></p>' : "");
            }
          </script>
        </body>
        </html>
      `, {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    if (url.pathname === "/api/upload-trip" && request.method === "POST") {
      try {
        const tripJson = await request.json();

        const tripId =
          tripJson?.trip?.tripIdentifier ||
          tripJson?.trip?.id ||
          tripJson?.flightReservations?.[0]?.tripID ||
          tripJson?.hotelVouchers?.[0]?.tripID;

        if (!tripId) {
          return Response.json({
            success: false,
            message: "No encontré tripIdentifier ni tripID en el JSON."
          }, { status: 400 });
        }

        await env.TRIPS.put(tripId, JSON.stringify(tripJson));

        return Response.json({
          success: true,
          message: "Viaje guardado correctamente.",
          trip_id: tripId,
          link: "/v/" + tripId
        });
      } catch (error) {
        return Response.json({
          success: false,
          message: "El JSON no es válido o hubo un error al guardarlo.",
          error: String(error)
        }, { status: 400 });
      }
    }

    if (url.pathname.startsWith("/v/")) {
      const tripId = decodeURIComponent(url.pathname.replace("/v/", ""));
      const tripText = await env.TRIPS.get(tripId);

      if (!tripText) {
        return new Response("No encontré este viaje.", { status: 404 });
      }

      const tripJson = JSON.parse(tripText);
      const trip = tripJson.trip || {};
      const flights = tripJson.flightReservations || [];
      const hotels = tripJson.hotelVouchers || [];
      const services = tripJson.serviceBookings || [];

      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8" />
          <title>${trip.name || "Yompr Concierge"}</title>
        </head>
        <body style="font-family: Arial; padding: 24px;">
          <h1>${trip.name || "Yompr Concierge"}</h1>
          <p><b>Destino:</b> ${trip.destination || ""}</p>

          <h2>Vuelos</h2>
          <p>${flights.length} reservación(es) de vuelo</p>

          <h2>Hospedaje</h2>
          <p>${hotels.length} voucher(s) de hospedaje</p>

          <h2>Servicios / Actividades</h2>
          <p>${services.length} servicio(s)</p>

          <hr>
          <p>Yompr Personal Concierge — primera versión funcionando.</p>
        </body>
        </html>
      `, {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    return new Response("Ruta no encontrada", { status: 404 });
  }
};
