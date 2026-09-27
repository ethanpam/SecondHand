(function(root) {
  'use strict';
  
  const en = {
    // panel.html
    "Autofill": "Autofill",
    "Unlock SecondHand": "Unlock SecondHand",
    "Stop": "Stop",
    "Details": "Details",
    "Iowa · uses first home address suggestion": "Iowa · uses first home address suggestion",
    "SecondHand": "SecondHand",
    "IOWA SNAP": "IOWA SNAP",
    "Checking SecondHand…": "Checking SecondHand…",
    "Unlock": "Unlock",
    "Also turn on the embedded form": "Also turn on the embedded form",
    "Turn on SecondHand for this site": "Turn on SecondHand for this site",
    "On Iowa’s verified steps, Autofill continues verified information screens and complete applicant pages, then selects the first suggested home address and continues. Review that address before submitting. Tell Us More and unsupported steps still need your answers and Continue.": "On Iowa’s verified steps, Autofill continues verified information screens and complete applicant pages, then selects the first suggested home address and continues. Review that address before submitting. Tell Us More and unsupported steps still need your answers and Continue.",
    "Autofill this page": "Autofill this page",
    "Checking the application in your active tab…": "Checking the application in your active tab…",
    "Turn off SecondHand for this site": "Turn off SecondHand for this site",
    "On this page": "On this page",
    "Review every answer. Signatures, consent, and final submission stay with you.": "Review every answer. Signatures, consent, and final submission stay with you.",
    "SecondHand · Iowa SNAP assistant": "SecondHand · Iowa SNAP assistant",

    // panel.js
    "SecondHand was updated. Open chrome://extensions and click the reload arrow on SecondHand, then reload this page.": "SecondHand was updated. Open chrome://extensions and click the reload arrow on SecondHand, then reload this page.",
    "The assistant is unavailable. Reload the extension and this page.": "The assistant is unavailable. Reload the extension and this page.",
    "Working…": "Working…",
    "On-device AI unavailable. Rule matches only.": "On-device AI unavailable. Rule matches only.",
    "Find it in the form.": "Find it in the form.",
    "Find it in Iowa’s form.": "Find it in Iowa’s form.",
    "Unlock SecondHand, then click Autofill.": "Unlock SecondHand, then click Autofill.",
    "Done": "Done",
    "Needs you": "Needs you",
    "Optional": "Optional",
    "Do it yourself": "Do it yourself",
    "Stop autofill": "Stop autofill",
    "Waiting for the page to finish loading…": "Waiting for the page to finish loading…",
    "Reload this page so SecondHand can read it.": "Reload this page so SecondHand can read it.",
    "Click Autofill. SecondHand fills what it recognizes and lists what needs you. It never submits.": "Click Autofill. SecondHand fills what it recognizes and lists what needs you. It never submits.",
    "Click Autofill. SecondHand fills what it can and tells you what it needs.": "Click Autofill. SecondHand fills what it can and tells you what it needs.",
    "Nothing to fill on this page. Continue in Iowa’s form.": "Nothing to fill on this page. Continue in Iowa’s form.",
    "Open Iowa’s SNAP application in this tab. Your checklist appears here automatically. On another food-assistance form, click the SecondHand toolbar icon.": "Open Iowa’s SNAP application in this tab. Your checklist appears here automatically. On another food-assistance form, click the SecondHand toolbar icon.",
    "SecondHand isn’t running. Open the app on this computer.": "SecondHand isn’t running. Open the app on this computer.",
    "SecondHand is unlocked.": "SecondHand is unlocked.",
    "SecondHand is locked.": "SecondHand is locked.",
    "Stopping autofill…": "Stopping autofill…",
    "Filling your saved answers…": "Filling your saved answers…",
    "Chrome couldn’t ask for access to this site.": "Chrome couldn’t ask for access to this site.",
    "Chrome didn’t allow SecondHand on this site. Nothing changed.": "Chrome didn’t allow SecondHand on this site. Nothing changed.",
    "Approve this site in the SecondHand app…": "Approve this site in the SecondHand app…",
    "Chrome couldn’t ask for access to the embedded form.": "Chrome couldn’t ask for access to the embedded form.",
    "Chrome didn’t allow SecondHand on the embedded form. Nothing changed.": "Chrome didn’t allow SecondHand on the embedded form. Nothing changed.",
    "Approve the embedded form in the SecondHand app…": "Approve the embedded form in the SecondHand app…",
    "SecondHand is on for the embedded form. Click Autofill.": "SecondHand is on for the embedded form. Click Autofill.",
    "Turning SecondHand off for this site…": "Turning SecondHand off for this site…",
    "SecondHand is off for this site. Reload the page to remove its button.": "SecondHand is off for this site. Reload the page to remove its button.",
    
    // new translation feature
    "Language": "Language",
    "Show questions in Español": "Show questions in Español",
    "Show questions in English": "Show questions in English",
    "Ver preguntas en español": "Ver preguntas en español",
    "View questions in English": "View questions in English",
    "Downloading translation model": "Downloading translation model",
    "Translation unavailable.": "Translation unavailable."
  };

  const es = {
    "Autofill": "Autocompletar",
    "Unlock SecondHand": "Desbloquear SecondHand",
    "Stop": "Detener",
    "Details": "Detalles",
    "Iowa · uses first home address suggestion": "Iowa · usa la primera sugerencia de domicilio",
    "SecondHand": "SecondHand",
    "IOWA SNAP": "IOWA SNAP",
    "Checking SecondHand…": "Comprobando SecondHand…",
    "Unlock": "Desbloquear",
    "Also turn on the embedded form": "También activa el formulario integrado",
    "Turn on SecondHand for this site": "Activa SecondHand para este sitio",
    "On Iowa’s verified steps, Autofill continues verified information screens and complete applicant pages, then selects the first suggested home address and continues. Review that address before submitting. Tell Us More and unsupported steps still need your answers and Continue.": "En los pasos verificados de Iowa, Autocompletar continúa las pantallas de información verificada y páginas completas de solicitantes, luego selecciona el primer domicilio sugerido y continúa. Revisa esa dirección antes de enviar. 'Cuéntanos más' y los pasos no compatibles aún necesitan tus respuestas y que presiones Continuar.",
    "Autofill this page": "Autocompletar esta página",
    "Checking the application in your active tab…": "Comprobando la solicitud en tu pestaña activa…",
    "Turn off SecondHand for this site": "Desactiva SecondHand para este sitio",
    "On this page": "En esta página",
    "Review every answer. Signatures, consent, and final submission stay with you.": "Revisa cada respuesta. Firmas, consentimiento y el envío final son tu responsabilidad.",
    "SecondHand · Iowa SNAP assistant": "SecondHand · Asistente de SNAP de Iowa",

    "SecondHand was updated. Open chrome://extensions and click the reload arrow on SecondHand, then reload this page.": "SecondHand se actualizó. Abre chrome://extensions y haz clic en la flecha de recargar en SecondHand, luego recarga esta página.",
    "The assistant is unavailable. Reload the extension and this page.": "El asistente no está disponible. Recarga la extensión y esta página.",
    "Working…": "Trabajando…",
    "On-device AI unavailable. Rule matches only.": "IA en dispositivo no disponible. Solo coincidencias por reglas.",
    "Find it in the form.": "Encuéntralo en el formulario.",
    "Find it in Iowa’s form.": "Encuéntralo en el formulario de Iowa.",
    "Unlock SecondHand, then click Autofill.": "Desbloquea SecondHand, luego haz clic en Autocompletar.",
    "Done": "Completado",
    "Needs you": "Te necesita",
    "Optional": "Opcional",
    "Do it yourself": "Hazlo tú mismo",
    "Stop autofill": "Detener autocompletar",
    "Waiting for the page to finish loading…": "Esperando a que la página termine de cargar…",
    "Reload this page so SecondHand can read it.": "Recarga esta página para que SecondHand pueda leerla.",
    "Click Autofill. SecondHand fills what it recognizes and lists what needs you. It never submits.": "Haz clic en Autocompletar. SecondHand completa lo que reconoce y lista lo que te necesita. Nunca envía el formulario.",
    "Click Autofill. SecondHand fills what it can and tells you what it needs.": "Haz clic en Autocompletar. SecondHand completa lo que puede y te dice lo que necesita.",
    "Nothing to fill on this page. Continue in Iowa’s form.": "Nada para completar en esta página. Continúa en el formulario de Iowa.",
    "Open Iowa’s SNAP application in this tab. Your checklist appears here automatically. On another food-assistance form, click the SecondHand toolbar icon.": "Abre la solicitud SNAP de Iowa en esta pestaña. Tu lista de verificación aparece aquí automáticamente. En otro formulario de asistencia alimentaria, haz clic en el icono de SecondHand.",
    "SecondHand isn’t running. Open the app on this computer.": "SecondHand no se está ejecutando. Abre la aplicación en esta computadora.",
    "SecondHand is unlocked.": "SecondHand está desbloqueado.",
    "SecondHand is locked.": "SecondHand está bloqueado.",
    "Stopping autofill…": "Deteniendo autocompletar…",
    "Filling your saved answers…": "Completando tus respuestas guardadas…",
    "Chrome couldn’t ask for access to this site.": "Chrome no pudo pedir acceso a este sitio.",
    "Chrome didn’t allow SecondHand on this site. Nothing changed.": "Chrome no permitió SecondHand en este sitio. No cambió nada.",
    "Approve this site in the SecondHand app…": "Aprueba este sitio en la aplicación SecondHand…",
    "Chrome couldn’t ask for access to the embedded form.": "Chrome no pudo pedir acceso al formulario integrado.",
    "Chrome didn’t allow SecondHand on the embedded form. Nothing changed.": "Chrome no permitió SecondHand en el formulario integrado. No cambió nada.",
    "Approve the embedded form in the SecondHand app…": "Aprueba el formulario integrado en la aplicación SecondHand…",
    "SecondHand is on for the embedded form. Click Autofill.": "SecondHand está activo para el formulario integrado. Haz clic en Autocompletar.",
    "Turning SecondHand off for this site…": "Desactivando SecondHand para este sitio…",
    "SecondHand is off for this site. Reload the page to remove its button.": "SecondHand está desactivado para este sitio. Recarga la página para quitar su botón.",
    
    "Language": "Idioma",
    "Show questions in Español": "Mostrar preguntas en Español",
    "Show questions in English": "Mostrar preguntas en Inglés",
    "Ver preguntas en español": "Ver preguntas en español",
    "View questions in English": "Ver preguntas en Inglés",
    "Downloading translation model": "Descargando modelo de traducción",
    "Translation unavailable.": "Traducción no disponible."
  };

  function getLanguage() {
    try {
      const stored = localStorage.getItem('secondhand-lang');
      if (stored === 'es' || stored === 'en') return stored;
    } catch {}
    return navigator.language.startsWith('es') ? 'es' : 'en';
  }

  function setLanguage(lang) {
    try {
      localStorage.setItem('secondhand-lang', lang);
    } catch {}
  }

  function t(text) {
    if (!text) return text;
    const lang = getLanguage();
    if (lang === 'en') return text; // en is the source
    
    // Exact match
    if (es[text]) return es[text];
    
    // Let's also do some basic dynamic matching for background.js strings if they appear in Spanish.
    // For now, if no match, return original text.
    let translated = text;
    
    // Dynamic matching for "X of Y done"
    const doneMatch = text.match(/^(\d+) of (\d+) done$/);
    if (doneMatch) return `${doneMatch[1]} de ${doneMatch[2]} completado`;
    
    // Dynamic matching for "X need you"
    const needYouMatch = text.match(/^(\d+) need you$/);
    if (needYouMatch) return `${needYouMatch[1]} te necesita`;
    
    // Dynamic matching for widgets
    const filledMatch = text.match(/^Filled (\d+)( · (\d+) guessed)?( · (\d+) need you)?(?:\. (.*))?$/);
    if (filledMatch) {
      let msg = `Completado ${filledMatch[1]}`;
      if (filledMatch[3]) msg += ` · ${filledMatch[3]} supuestos`;
      if (filledMatch[5]) msg += ` · ${filledMatch[5]} te necesita`;
      if (filledMatch[6]) msg += `. ${t(filledMatch[6])}`;
      return msg;
    }

    const hostMatch = text.match(/^SecondHand can fill forms on (.*) after you turn it on here and approve it in the SecondHand app\.$/);
    if (hostMatch) return `SecondHand puede autocompletar formularios en ${hostMatch[1]} después de que lo actives aquí y lo apruebes en la aplicación SecondHand.`;

    const hostMatch2 = text.match(/^SecondHand is on for (.*)\. Click Autofill\.$/);
    if (hostMatch2) return `SecondHand está activo para ${hostMatch2[1]}. Haz clic en Autocompletar.`;

    const alsoTurnOnMatch = text.match(/^Also turn on the embedded form \((.*)\)$/);
    if (alsoTurnOnMatch) return `También activa el formulario integrado (${alsoTurnOnMatch[1]})`;

    const siteReadyMatch = text.match(/^(.*) · ready$/);
    if (siteReadyMatch) return `${siteReadyMatch[1]} · listo`;

    // background.js general strings translation
    const bgMap = {
      "The desktop declined this request.": "El escritorio rechazó esta solicitud.",
      "Cannot reach SecondHand. Open the app and prepare its Chrome extension.": "No se puede contactar a SecondHand. Abre la aplicación y prepara su extensión de Chrome.",
      "Open the official Iowa portal in the active tab, then try again.": "Abre el portal oficial de Iowa en la pestaña activa y vuelve a intentarlo.",
      "The page changed. Wait for it to finish loading.": "La página cambió. Espera a que termine de cargar.",
      "Open the SecondHand app, then click Autofill again.": "Abre la aplicación SecondHand y luego haz clic en Autocompletar nuevamente.",
      "Unlock SecondHand to autofill.": "Desbloquea SecondHand para autocompletar.",
      "Cancelled. Nothing was filled.": "Cancelado. No se completó nada.",
      "Autofill failed. Fill this page yourself.": "Autocompletar falló. Completa esta página tú mismo.",
      "Update and reopen SecondHand, then reload this extension. Its authorization response is outdated.": "Actualiza y vuelve a abrir SecondHand, luego recarga esta extensión. Su respuesta de autorización está desactualizada.",
      "Desktop access changed. Review the page, then click Autofill again.": "El acceso de escritorio cambió. Revisa la página, luego haz clic en Autocompletar nuevamente.",
      "Autofill stopped. Nothing further will be filled or advanced.": "Autocompletar detenido. No se completará ni avanzará nada más.",
      "The desktop did not return supported profile fields.": "El escritorio no devolvió campos de perfil compatibles.",
      "The page changed. Click Autofill again.": "La página cambió. Haz clic en Autocompletar de nuevo.",
      "This page couldn’t be filled safely. Fill it yourself.": "Esta página no pudo completarse de manera segura. Complétala tú mismo.",
      "The page changed. Check it before continuing.": "La página cambió. Revísala antes de continuar.",
      "Nothing new to fill.": "Nada nuevo para completar.",
      "The page changed. Review it before continuing.": "La página cambió. Revísala antes de continuar.",
      "The page changed before navigation. Review it.": "La página cambió antes de la navegación. Revísala.",
      "Review this page and continue in Iowa’s form.": "Revisa esta página y continúa en el formulario de Iowa.",
      "Selected Save and Continue once. Waiting for Iowa’s next step.": "Seleccionó Guardar y Continuar una vez. Esperando el próximo paso de Iowa.",
      "Continuing…": "Continuando…",
      "Click Continue in Iowa’s form.": "Haz clic en Continuar en el formulario de Iowa.",
      "SecondHand doesn’t know this page yet. Fill it in, then continue.": "SecondHand aún no conoce esta página. Complétala y luego continúa.",
      "Autofill stopped.": "Autocompletar detenido.",
      "Check your answers, then click Continue.": "Revisa tus respuestas y luego haz clic en Continuar.",
      "Turn on SecondHand for this site in the side panel first.": "Activa SecondHand para este sitio en el panel lateral primero.",
      "Open the form in the active tab, then try again.": "Abre el formulario en la pestaña activa y vuelve a intentarlo.",
      "Chrome hasn’t allowed SecondHand on this site. Click Turn on again and allow it.": "Chrome no ha permitido SecondHand en este sitio. Haz clic en Activar de nuevo y permítelo.",
      "The SecondHand app did not approve this site.": "La aplicación SecondHand no aprobó este sitio.",
      "Reload this page, then click Autofill.": "Recarga esta página, luego haz clic en Autocompletar.",
      "Part of this form couldn’t be filled safely. Fill it yourself.": "Parte de este formulario no se pudo completar de forma segura. Complétalo tú mismo.",
      "Chrome kept SecondHand’s access to this site. Remove it on Chrome’s extension page.": "Chrome mantuvo el acceso de SecondHand a este sitio. Quítalo en la página de extensiones de Chrome.",
      "Chrome hasn’t allowed SecondHand on the embedded form. Click Also turn on again and allow it.": "Chrome no ha permitido SecondHand en el formulario integrado. Haz clic en También activar de nuevo y permítelo.",
      "The SecondHand app did not approve this embedded form.": "La aplicación SecondHand no aprobó este formulario integrado.",
      "The page changed. Try again.": "La página cambió. Inténtalo de nuevo.",
      "Nothing to fill here. Click Next, then Autofill again.": "Nada para completar aquí. Haz clic en Siguiente, luego en Autocompletar de nuevo.",
      "Nothing to fill here.": "Nada para completar aquí.",
      "This page couldn’t be checked safely. Fill it yourself.": "Esta página no se pudo verificar de forma segura. Complétala tú mismo.",
      "SecondHand couldn’t use the on-device AI’s matches. Nothing was filled.": "SecondHand no pudo usar las coincidencias de la IA en el dispositivo. No se completó nada.",
      "SecondHand could not prepare the field request.": "SecondHand no pudo preparar la solicitud de campo.",
      "Iowa’s form is filled by its own rules only.": "El formulario de Iowa se completa solo bajo sus propias reglas.",
      "That field isn’t on this page.": "Ese campo no está en esta página.",
      "Turn on SecondHand for this embedded form first.": "Activa SecondHand para este formulario integrado primero.",
      "Use the SecondHand toolbar icon to open the side panel.": "Usa el ícono de la barra de herramientas de SecondHand para abrir el panel lateral.",
      "SecondHand could not complete the request.": "SecondHand no pudo completar la solicitud.",
      "Autofill stopped because the active tab changed.": "Autocompletar se detuvo porque la pestaña activa cambió.",
      "Complete this step in Iowa’s form. SecondHand has not verified its controls.": "Completa este paso en el formulario de Iowa. SecondHand no ha verificado sus controles.",
      "SecondHand selects the first suggested home address and saves this step. Review it before final submission.": "SecondHand selecciona el primer domicilio sugerido y guarda este paso. Revísalo antes del envío final.",
      "Review this address step and continue in Iowa’s form yourself.": "Revisa este paso de dirección y continúa tú mismo en el formulario de Iowa.",
      "SecondHand can fill your saved date of birth on this verified self-information page. Review and answer the other questions, then choose Save and Continue directly in Iowa’s form.": "SecondHand puede autocompletar tu fecha de nacimiento guardada en esta página de auto-información verificada. Revisa y contesta las otras preguntas, luego selecciona Guardar y Continuar directamente en el formulario de Iowa.",
      "Complete the missing answers in Iowa’s form. SecondHand will check again before continuing.": "Completa las respuestas faltantes en el formulario de Iowa. SecondHand volverá a verificar antes de continuar.",
      "SecondHand can save this verified page and continue. Review every answer before final submission.": "SecondHand puede guardar esta página verificada y continuar. Revisa cada respuesta antes del envío final.",
      "Information only. SecondHand can continue for you.": "Solo información. SecondHand puede continuar por ti.",
      "Read this page, then click Continue in Iowa’s form.": "Lee esta página, luego haz clic en Continuar en el formulario de Iowa.",
      "Nothing here matches your saved profile.": "Nada aquí coincide con tu perfil guardado."
    };

    // check if it's in the background map directly or if it contains a sentence from the background map
    if (bgMap[text]) return bgMap[text];
    
    // If it's a compound string separated by · or space
    for (const enStr of Object.keys(bgMap)) {
      if (text.includes(enStr)) {
        translated = translated.replace(enStr, bgMap[enStr]);
      }
    }
    
    // Check "Stopped after MAX_STEPS steps."
    const stoppedMatch = translated.match(/Stopped after (\d+) steps\. (.*)/);
    if (stoppedMatch) {
      return `Se detuvo después de ${stoppedMatch[1]} pasos. ${t(stoppedMatch[2])}`;
    }

    const insideMatch = translated.match(/This form is inside (.*)\. Click “Also turn on the embedded form” in the SecondHand side panel\./);
    if (insideMatch) return `Este formulario está dentro de ${insideMatch[1]}. Haz clic en "También activa el formulario integrado" en el panel lateral de SecondHand.`;

    const summaryMatch = translated.match(/^(.*)\. Check your answers before you submit\.$/);
    if (summaryMatch) return `${t(summaryMatch[1])}. Revisa tus respuestas antes de enviarlas.`;

    return translated;
  }

  const api = Object.freeze({ en, es, getLanguage, setLanguage, t });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandStrings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
