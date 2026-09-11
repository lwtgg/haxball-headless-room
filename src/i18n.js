/**
 * All player-facing text lives here. Every entry is a function so messages can
 * take arguments. To add another language later, copy this object, translate
 * it, and pick between them at load time.
 */
const es = {
  // --- bienvenida ---
  welcome: (n) => `¡Bienvenido ${n}! Escribe !ayuda para ver los comandos.`,
  welcomeDiscord: (link) => `Discord: ${link}`,
  banned: 'Estás baneado de esta sala.',

  // --- partido ---
  matchOn: (goals, mins) => `¡Empieza el partido! Primero a ${goals} goles o ${mins} minutos.`,
  waiting: 'Faltan jugadores para empezar.',
  waitingCount: (n) => `Faltan jugadores para empezar. Hay ${n} en la sala.`,
  waitingWithAfk: (n, afk) =>
    `Faltan jugadores. Hay ${n} en la sala pero ${afk} está(n) AFK. Escriban !afk para volver.`,
  afkHowToReturn: 'Escribe !afk para volver a la fila.',
  modeSwitched: (m) => `Modo ${m}. Cambiando el mapa.`,
  soloTraining: 'Estás solo. Mapa de entrenamiento hasta que llegue alguien.',
  nextMatchIn: (secs) => `Siguiente partido en ${secs}s.`,
  modeInfo: (m, waiting) => `Modo actual: ${m}. En la fila: ${waiting}.`,
  modeForced: (m) => `Un admin fijó el modo en ${m}.`,
  modeAuto: 'Modo automático activado. El bot elige según los jugadores.',
  modeBad: 'Uso: !modo <1v1|2v2|3v3|4v4|auto>',
  queueWaiting: (n) => `${n} en la fila esperando turno.`,
  grewTo: (m) => `Se unieron jugadores. Ahora es ${m}.`,
  upgradeInterrupt: (m) => `¡Ya hay para ${m}! Cambiando de mapa, el partido se reinicia.`,
  substituted: (n) => `${n} entra de la fila.`,
  evenedUp: (n) => `${n} sale para emparejar los equipos y vuelve al principio de la fila.`,
  unevenNoSubs: 'Equipo incompleto y no hay nadie en la fila.',

  // --- capitán / elección ---
  captainIs: (n, mode) => `👑 ${n} es capitán y elige su equipo (${mode}).`,
  pickPrompt: (n, left) => `${n}: escribe el número del jugador que quieres. Te faltan ${left}.`,
  pickList: (list) => `Elige: ${list}`,
  picked: (cap, chosen) => `${cap} eligió a ${chosen}.`,
  pickNotCaptain: 'No eres el capitán.',
  pickInvalid: 'Ese número no está en la lista.',
  pickTimeout: (n) => `${n} tardó demasiado en elegir. Sale de la sala.`,
  captainPassed: (n) => `👑 Le toca a ${n}. Ahora eliges tú.`,
  yieldedSeat: (out, inn) => `${out} cede su lugar a ${inn}.`,
  yieldOn: 'Vas a ceder tu lugar cuando llegue alguien o falte sitio.',
  yieldOff: 'Ya no cedes tu lugar. Juegas como todos.',
  pickKickReason: 'Tardaste demasiado en elegir',
  queueEmpty: 'No hay nadie esperando.',
  queueList: (names) => `Fila: ${names}`,
  teamsShuffled: 'Equipos mezclados.',
  sidesSwapped: 'Revancha: los mismos, pero cambiando de lado.',
  teamsScrambled: 'Revancha: equipos mezclados.',
  draw: 'Empate. Los dos equipos salen.',
  winnerStays: (t) => `${t} gana y se queda.`,
  red: 'Rojo',
  blue: 'Azul',

  // --- goles ---
  goal: (scorer, assist) => (assist ? `⚽ ${scorer}  (asistencia: ${assist})` : `⚽ ${scorer}`),
  ownGoal: (n) => `Autogol de ${n}.`,
  hatTrick: (n) => `🎩 ¡HAT-TRICK de ${n}!`,
  brace: (n) => `🔥 ${n} lleva 2 goles.`,
  streak: (t, n) => `${t} lleva ${n} victorias seguidas.`,
  mvp: (n, g, a) => `⭐ MVP: ${n} (${g}G ${a}A)`,
  cleanSheet: (t) => `🧤 ${t} dejó la portería en cero.`,

  // --- afk ---
  afkOn: (n) => `${n} está AFK. Escribe !afk otra vez para volver.`,
  afkOff: (n) => `${n} volvió a la fila.`,
  afkKicked: (n) => `${n} fue expulsado por estar AFK. Puede volver a entrar cuando quiera.`,
  afkKickReason: 'AFK — vuelve a entrar cuando estés listo',
  afkWarningPublic: (n) => `${n} lleva rato sin moverse.`,
  afkBack: (n) => `${n} está de vuelta.`,
  afkWarning: (secs) => `¿Sigues ahí? Te saco de la sala en ${secs}s. Muévete.`,
  afkNone: 'Nadie está AFK.',
  afkList: (names) => `AFK: ${names}`,

  // --- stats ---
  myStats: (n, s) =>
    `${n} — ${s.goals} goles, ${s.assists} asistencias, ${s.wins}V/${s.losses}D en ${s.games} partidos, ${s.cleanSheets} vallas invictas`,
  showStats: (n, s) => `${n} — ${s.goals}G ${s.assists}A ${s.wins}V en ${s.games} partidos`,
  statsReset: 'Tus estadísticas fueron reiniciadas.',
  topTitle: (label) => `Top ${label}:`,
  noData: 'Todavía no hay datos.',

  // --- economía ---
  balance: (coin, amount) => `Tienes ${amount} ${coin}.`,
  earned: (coin, amount, why) => `+${amount} ${coin} (${why})`,
  reasonGoal: 'gol',
  reasonAssist: 'asistencia',
  reasonWin: 'victoria',
  reasonCleanSheet: 'valla invicta',
  reasonPlayed: 'partido jugado',
  notEnoughCoins: (coin) => `No tienes suficientes ${coin}.`,
  transferOk: (amount, coin, to) => `Enviaste ${amount} ${coin} a ${to}.`,
  transferGot: (amount, coin, from) => `Recibiste ${amount} ${coin} de ${from}.`,
  transferSelf: 'No puedes enviarte monedas a ti mismo.',
  transferBad: (coin) => `Uso: !dar #id <cantidad de ${coin}>`,

  // --- tienda ---
  storeTitle: (coin) => `TIENDA — paga con ${coin}. Compra con !comprar <id>`,
  storeLine: (item) => `${item.id} — ${item.name} — ${item.price}`,
  storeOwned: (name) => `Ya tienes "${name}".`,
  storeBought: (name) => `¡Compraste "${name}"! Actívalo con !celebracion.`,
  storeUnknown: 'Ese artículo no existe. Mira !tienda.',

  // --- celebración ---
  celebNone: 'No tienes celebraciones. Compra una en !tienda.',
  celebList: (owned) => `Tus celebraciones: ${owned}. Usa !celebracion <id> para elegir.`,
  celebSet: (name) => `Celebración cambiada a "${name}".`,
  celebNotOwned: 'No tienes esa celebración.',

  // --- rangos ---
  rankUp: (n, rank) => `📈 ¡${n} subió a ${rank}!`,
  rankInfo: (n, rank, xp, next) =>
    next
      ? `${n} — Rango: ${rank} (${xp} XP). Siguiente: ${next.name} a los ${next.xp} XP.`
      : `${n} — Rango: ${rank} (${xp} XP). ¡Rango máximo!`,

  // --- apuestas ---
  betOpen: 'Apuestas abiertas. Usa !apostar <cantidad> <rojo|azul>',
  betClosed: 'Las apuestas ya cerraron para este partido.',
  betBad: 'Uso: !apostar <cantidad> <rojo|azul>',
  betPlaced: (amount, coin, team) => `Apostaste ${amount} ${coin} al ${team}.`,
  betAlready: 'Ya tienes una apuesta en este partido.',
  betNoGame: 'Solo puedes apostar cuando hay partido.',
  betPlaying: 'No puedes apostar en tu propio partido. Solo espectadores.',
  betTooBig: (max, coin) => `La apuesta máxima es ${max} ${coin}.`,
  betWon: (amount, coin) => `🎉 Ganaste tu apuesta: +${amount} ${coin}`,
  betLost: (amount, coin) => `Perdiste tu apuesta de ${amount} ${coin}.`,
  betRefund: (amount, coin) => `Empate, te devolvemos ${amount} ${coin}.`,

  // --- moderación ---
  muted: (n) => `${n} fue muteado.`,
  unmuted: (n) => `${n} fue desmuteado.`,
  youAreMuted: 'Estás muteado.',
  mutesNone: 'Nadie está muteado.',
  mutesList: (names) => `Muteados: ${names}`,
  bansNone: 'No hay baneados.',
  banLifted: (id) => `Baneo ${id} levantado.`,
  adminOk: (n) => `${n} ahora es admin.`,
  adminBadPass: 'Contraseña incorrecta.',
  adminOnly: 'Ese comando es solo para admins.',
  notFound: 'No se encontró al jugador.',
  ambiguousName: 'Hay más de un jugador con ese nombre. Usa el #id:',
  ignoreSelf: 'No puedes bloquearte a ti mismo.',
  ignoreTooMany: 'Tienes demasiada gente bloqueada.',
  rotationOn: 'El bot vuelve a manejar los equipos y los partidos.',
  rotationOff: 'Rotación automática PAUSADA. Un admin tiene el control (!empezar para devolverla).',
  noAuthSave: 'Tu sesión no tiene auth, así que tus stats y monedas no se guardan.',
  unknownCmd: (c) => `Comando desconocido: !${c}. Escribe !ayuda.`,
  cmdError: 'Algo salió mal con ese comando.',
  paused: 'Pausa corta.',
  // --- pausa de capitán / cambios ---
  pauseOpen: (secs) => `PAUSA ${secs}s. Capitán: !banquear #id para cambiar a alguien de tu equipo.`,
  pauseOver: 'Se reanuda el partido.',
  pauseNotCaptain: 'Solo el capitán de un equipo (o un admin) puede pausar.',
  pauseNoGame: 'No hay partido en curso.',
  pauseAlready: 'Ya hay una pausa activa.',
  pauseUsed: 'Tu equipo ya usó su pausa en este partido.',
  benchNoPause: 'Primero escribe !pausa. Solo se puede cambiar durante la pausa.',
  benchNotCaptain: 'Solo el capitán que pidió la pausa puede hacer el cambio.',
  benchUsage: 'Uso: !banquear #id (el jugador tiene que ser de tu equipo).',
  benchNotYourTeam: 'Ese jugador no es de tu equipo.',
  benchNobodyWaiting: 'No hay nadie en la fila para entrar.',
  benchPrompt: (out) => `Sale ${out}. Elige quién entra escribiendo su número:`,
  benchDone: (out, inn) => `Cambio: sale ${out}, entra ${inn}.`,
  helpTitle: 'Comandos:',

  // --- protección de sala ---
  guardNoPermission: 'No puedes hacer eso. Te quitamos el admin.',
  guardNoPromote: 'No puedes dar admin a otros jugadores.',
  guardNoStadium: 'El mapa no se puede cambiar.',
  guardStadiumReverted: 'Un jugador intentó cambiar el mapa. Restaurado.',
  guardNoUnlock: 'Los equipos los maneja el bot. No se pueden desbloquear.',
  guardNoKickRate: 'No puedes cambiar el límite de expulsiones.',
  yourAuth: (a) => `Tu auth: ${a}`,
  authUnknown: 'Todavía no tengo tu auth. Vuelve a entrar a la sala.',
  // --- antispam ---
  spamRepeat: (secs) => `Estás repitiendo el mismo mensaje. Espera ${secs}s.`,
  spamWait: (secs) => `Espera ${secs}s antes de volver a escribir eso.`,

  // --- kits ---
  kitList: (names) => `Kits: ${names}`,
  kitsRandom: (red, blue) => `Kits de hoy: ${red} (rojo) vs ${blue} (azul). Capitanes: !kit para cambiar.`,
  kitSet: (team, kit) => `Kit de ${team}: ${kit}.`,
  kitUnknown: 'Ese kit no existe. Escribe !kit para ver la lista.',
  kitNotCaptain: 'Solo el capitán de tu equipo puede cambiar el kit.',
  kitNotPlaying: 'Tienes que estar en un equipo para cambiar el kit.',
  kitCaptainIs: (n) => `El capitán de tu equipo es ${n}.`,

  bye: 'Nos vemos',
};

module.exports = { t: es, es };
