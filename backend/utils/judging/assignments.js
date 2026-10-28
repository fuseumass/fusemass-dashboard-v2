"use strict";

// ============================================================================
// Judging Assignment API - JSON Based
// ============================================================================

/**
 * Generates judging assignments from JSON input and returns JSON output
*
 * @param {Object} config Configuration object
 * @param {Array} config.teams Array of team objects {name: string, tableNumber: number}
 * @param {Array} config.judges Array of judge objects {name: string}
 * @param {number} config.judgingsPerProject Number of times each project should be judged
 * @param {number} config.numRooms Number of judging rooms
 * @param {Array} [config.roomCapacities] Optional array of capacities for each room
 * @param {function} [config.rng=Math.random] Random source returning [0, 1).
 * @param {number} [config.maxAttempts=10] Maximum retry attempts
 * @returns {Object} {success, assignments, issues, log}. Each judge has a compact
 * assignments queue (legacy behavior) and slots preserving -1 time-slot gaps.
 * Throws with the team name when repair cannot produce a valid schedule.
 */
function generateJudgingAssignments({
  teams,
  judges,
  judgingsPerProject,
  numRooms,
  roomCapacities = null,
  maxAttempts = 10,
  rng = Math.random,
}) {
  var log = [];
  if (!teams || !Array.isArray(teams) || teams.length === 0) {
    return { success: false, assignments: [], log: log, issues: ["No teams provided"] }
  }
  if (!judges || !Array.isArray(judges) || judges.length === 0) {
    return { success: false, assignments: [], log: log, issues: ["No judges provided"] }
  }
  if (!judgingsPerProject || judgingsPerProject < 1) {
    return { success: false, assignments: [], log: log, issues: ["Invalid judgingsPerProject value"] }
  }
  if (!numRooms || numRooms < 1) {
    return { success: false, assignments: [], log: log, issues: ["Invalid numRooms value"] }
  }

  var tableNumberToProject = {}
  for (var team of teams) {
    if (!team.tableNumber) {
      return { success: false, assignments: [], log: log, issues: [`Team "${team.name}" missing tableNumber`] }
    }
    tableNumberToProject[team.tableNumber] = {
      name: team.name,
      tableNumber: team.tableNumber,
    }
  }

  // Initialize system
  var system = {
    judges: judges.map(function judge(j, idx) { return {
      name: j.name,
      judgeId: 1001 + idx,
    }; }),
    projects: teams.map(function project(t) { return {
      name: t.name,
      tableNumber: t.tableNumber,
    }; }),
    numJudges: judges.length,
    totalProjects: teams.length,
    numRooms,
    judgingsPerProject,
    roomCapacities,
    rng,
    log,
    tableNumberToProject, // Add mapping to system
  }

  // Create rooms
  system.rooms = createRooms(system)

  log.push(`[v0] Initialized system with ${system.numJudges} judges and ${system.totalProjects} projects`)
  log.push("[v0] Room configuration:")
  for (var room of system.rooms) {
    log.push(`  Room ${room.roomId}: tables ${room.projects.join(", ")}`)
  }

  var attempt = 1
  var success = false
  var finalAssignments = null
  var finalIssues = []

  while (attempt <= maxAttempts && !success) {
    log.push(`\n[v0] Attempt ${attempt} of ${maxAttempts}`)

    var generator = new AssignmentGenerator(system)
    var assignments = generator.generateAssignments()

    var verifier = new AssignmentVerifier(system, assignments)
    var result = verifier.verifyAll()

    log.push(...result.log);
    success = result.success

    if (success) {
      log.push("[v0] All verifications passed successfully!")
      finalAssignments = result.assignments
    } else {
      log.push("\n[v0] Warning: Issues found in assignments:")
      for (var issue of result.issues) {
        log.push(`  - ${issue}`)
      }
      finalIssues = result.issues

      if (attempt < maxAttempts) {
        log.push("\n[v0] Retrying assignment generation...")
      }
    }

    attempt++
  }

  if (!success) {
    log.push("\n[v0] Failed to generate valid assignments after maximum attempts")
    return { success: false, assignments: [], issues: finalIssues, log: log }
  }

  var output = []
  for (var i = 0; i < finalAssignments.length; i++) {
    var judge = system.judges[i]

    // Filter out -1 (empty slots) and only return table numbers
    var tableNumbers = finalAssignments[i].filter(function occupied(tableNum) { return tableNum !== -1; })

    output.push({
      name: judge.name,
      assignments: tableNumbers,
      slots: finalAssignments[i].slice(),
    })
  }

  return {
    log: log,
    success: true,
    assignments: output,
    issues: [],
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createRooms(system) {
  var rooms = []

  // Sort projects by table number to ensure proper ordering
  var sortedProjects = [...system.projects].sort(function tableOrder(a, b) { return a.tableNumber - b.tableNumber; })

  if (system.roomCapacities && system.roomCapacities.length === system.numRooms) {
    // Use specified room capacities
    var projectIndex = 0

    for (var i = 0; i < system.numRooms; i++) {
      var capacity = system.roomCapacities[i]
      var projectRange = []

      for (var j = 0; j < capacity && projectIndex < sortedProjects.length; j++) {
        projectRange.push(sortedProjects[projectIndex].tableNumber)
        projectIndex++
      }

      rooms.push({
        roomId: i + 1,
        projects: projectRange,
        capacity: projectRange.length,
      })
    }
  } else {
    // Divide projects evenly across rooms
    var projectsPerRoom = Math.ceil(system.totalProjects / system.numRooms)

    for (var i = 0; i < system.numRooms; i++) {
      var startIdx = i * projectsPerRoom
      var endIdx = Math.min((i + 1) * projectsPerRoom, sortedProjects.length)
      var projectRange = []

      for (var j = startIdx; j < endIdx; j++) {
        projectRange.push(sortedProjects[j].tableNumber)
      }

      rooms.push({
        roomId: i + 1,
        projects: projectRange,
        capacity: projectRange.length,
      })
    }
  }

  return rooms
}

function shuffleArray(array, rng) {
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var previous = array[i];
    array[i] = array[j];
    array[j] = previous;
  }
}

// ============================================================================
// Assignment Generator
// ============================================================================

/**
 * @param {object} system - Projects, judges, rooms, counts and optional rng/log.
 * @returns {AssignmentGenerator} A fresh generator.
 */
class AssignmentGenerator {
  constructor(system) {
    this.log = [];
    this.system = system
    this.assignments = []
    this.projectCounts = {}
    this.judgeCounts = {}

    for (var project of system.projects) {
      this.projectCounts[project.tableNumber] = 0
    }
    for (var i = 0; i < system.numJudges; i++) {
      this.judgeCounts[i] = 0
    }

    this.totalJudgings = system.totalProjects * system.judgingsPerProject
    this.basePerJudge = Math.floor(this.totalJudgings / system.numJudges)
    this.extraAssignments = this.totalJudgings % system.numJudges

    this.judgesPerRoom = this._calculateJudgesPerRoom()

    this.initialRoomAssignments = []
    for (var roomIdx = 0; roomIdx < system.numRooms; roomIdx++) {
      for (var j = 0; j < this.judgesPerRoom[roomIdx]; j++) {
        this.initialRoomAssignments.push(roomIdx)
      }
    }
    shuffleArray(this.initialRoomAssignments, system.rng || Math.random)

    this.maxPerJudge = this.basePerJudge + (this.extraAssignments > 0 ? 1 : 0)
    this.teamsPerPhase = Math.ceil(this.maxPerJudge / system.numRooms)
  }

  /** @returns {number[][]} Time slots per judge, with -1 for empty slots. */
  generateAssignments() {
    this._createBalancedAssignments()
    return this.assignments
  }

  _calculateJudgesPerRoom() {
    var totalCapacity = this.system.rooms.reduce(function capacity(sum, room) { return sum + room.capacity; }, 0)
    var judgesPerRoom = []
    var assignedJudges = 0
    var fractionalParts = []

    for (var i = 0; i < this.system.numRooms; i++) {
      var room = this.system.rooms[i]
      var idealAllocation = (room.capacity / totalCapacity) * this.system.numJudges
      var baseAllocation = Math.floor(idealAllocation)
      var allocation = Math.min(baseAllocation, room.capacity)

      judgesPerRoom.push(allocation)
      assignedJudges += allocation
      fractionalParts.push({ roomIdx: i, fraction: idealAllocation - baseAllocation })
    }

    fractionalParts.sort(function fraction(a, b) { return b.fraction - a.fraction; })

    var remainingJudges = this.system.numJudges - assignedJudges
    for (var { roomIdx } of fractionalParts) {
      if (remainingJudges === 0) break
      if (judgesPerRoom[roomIdx] < this.system.rooms[roomIdx].capacity) {
        judgesPerRoom[roomIdx]++
        remainingJudges--
      }
    }

    return judgesPerRoom
  }

  _getTargetAssignments(judgeId) {
    return this.basePerJudge + (judgeId < this.extraAssignments ? 1 : 0)
  }

  _createBalancedAssignments() {
    var judgeOrder = Array.from({ length: this.system.numJudges }, function index(_, i) { return i; })

    for (var judgeId of judgeOrder) {
      var judgeAssignments = []
      var startRoom = this.initialRoomAssignments[judgeId]
      var targetAssignments = this._getTargetAssignments(judgeId)
      var remainingAssignments = targetAssignments
      var judgedTables = new Set()

      for (var phase = 0; phase < this.system.numRooms; phase++) {
        var currentRoom = (startRoom + phase) % this.system.numRooms
        var roomTeams = [...this.system.rooms[currentRoom].projects]
        var slotsThisPhase = Math.min(this.teamsPerPhase, remainingAssignments)

        for (var slot = 0; slot < slotsThisPhase; slot++) {
          var currentSlot = judgeAssignments.length
          var currentSlotAssignments = new Set()
          for (var prevJudgeAssignments of this.assignments) {
            if (currentSlot < prevJudgeAssignments.length) {
              currentSlotAssignments.add(prevJudgeAssignments[currentSlot])
            }
          }

          var availableTeams = this._getAvailableTeams(roomTeams, currentSlotAssignments, judgedTables)

          if (availableTeams.length === 0) {
            for (var otherRoom of this.system.rooms) {
              if (JSON.stringify(otherRoom.projects) !== JSON.stringify(roomTeams)) {
                availableTeams = this._getAvailableTeams(otherRoom.projects, currentSlotAssignments, judgedTables)
                if (availableTeams.length > 0) {
                  break
                }
              }
            }
          }

          if (availableTeams.length > 0) {
            var team = availableTeams.reduce(function least(min, t) { return this.projectCounts[t] < this.projectCounts[min] ? t : min; }.bind(this))

            judgeAssignments.push(team)
            judgedTables.add(team)
            this.projectCounts[team]++
            this.judgeCounts[judgeId]++
            remainingAssignments--

            var teamIdx = roomTeams.indexOf(team)
            if (teamIdx !== -1) {
              roomTeams.splice(teamIdx, 1)
            }
          } else {
            judgeAssignments.push(-1)
          }
        }
      }

      this.assignments.push(judgeAssignments)
    }
  }

  _getAvailableTeams(roomTeams, currentSlotAssignments, judgedTables) {
    var available = []
    for (var team of roomTeams) {
      if (
        !currentSlotAssignments.has(team) &&
        !judgedTables.has(team) &&
        this.projectCounts[team] < this.system.judgingsPerProject
      ) {
        available.push(team)
      }
    }
    return available
  }
}

// ============================================================================
// Assignment Verifier
// ============================================================================

/**
 * @param {object} system - Projects, judges and required judging count.
 * @param {number[][]} assignments - Time slots; -1 denotes an empty slot.
 * @returns {AssignmentVerifier} A verifier owning a copy of the schedule.
 */
class AssignmentVerifier {
  constructor(system, assignments) {
    this.log = [];
    this.system = system
    this.assignments = assignments.map(function copy(row) { return row.slice(); })
  }

  _verifyJudgingCount() {
    var projectCounts = {}

    for (var project of this.system.projects) {
      projectCounts[project.tableNumber] = 0
    }

    for (var judgeAssignments of this.assignments) {
      for (var tableNum of judgeAssignments) {
        if (tableNum !== -1) {
          projectCounts[tableNum] = (projectCounts[tableNum] || 0) + 1
        }
      }
    }

    var issues = []
    var underJudgedProjects = []
    var overJudgedProjects = []

    for (var project of this.system.projects) {
      var tableNum = project.tableNumber
      var count = projectCounts[tableNum] || 0
      if (count !== this.system.judgingsPerProject) {
        if (count < this.system.judgingsPerProject) {
          issues.push(
            `Table ${tableNum} (${project.name}) is judged ${count} times (should be ${this.system.judgingsPerProject})`,
          )
          underJudgedProjects.push({
            projectId: tableNum,
            current: count,
            needed: this.system.judgingsPerProject - count,
          })
        } else {
          issues.push(
            `Table ${tableNum} (${project.name}) is over-judged: ${count} times (should be ${this.system.judgingsPerProject})`,
          )
          overJudgedProjects.push({
            projectId: tableNum,
            current: count,
            excess: count - this.system.judgingsPerProject,
          })
        }
      }
    }

    return { issues, underJudgedProjects, overJudgedProjects }
  }

  _fixUnderJudgedProjects(underJudgedProjects) {
    for (var missing of underJudgedProjects) {
      var added = 0;
      for (var row of this.assignments) {
        if (added === missing.needed) break;
        if (row.includes(missing.projectId)) continue;
        // An appended slot is free only when no other judge has this
        // table at the destination index. Never overwrite a visit.
        for (var slot = 0; slot <= row.length; slot++) {
          if (slot < row.length && row[slot] !== -1) continue;
          var collision = this.assignments.some(function occupied(other) {
            return other[slot] === missing.projectId;
          });
          if (!collision) {
            row[slot] = missing.projectId;
            added++;
            this.log.push("Assigned Table " + missing.projectId + " at Slot " + (slot + 1));
            break;
          }
        }
      }
      if (added < missing.needed) {
        throw new Error(this._teamError(missing.projectId) + ": cannot place missing judgements in free slots");
      }
    }
  }

  _teamError(table) {
    var project = this.system.projects.find(function matching(p) { return p.tableNumber === table; });
    return "Table " + table + " (" + (project ? project.name : "unknown team") + ")";
  }

  _verifyUniqueVisits() {
    var issues = [];
    for (var row of this.assignments) {
      var seen = new Set();
      for (var table of row) {
        if (table === -1) continue;
        if (!this.system.projects.some(function known(p) { return p.tableNumber === table; })) {
          issues.push(this._teamError(table) + ": outside this room pool");
        }
        if (seen.has(table)) issues.push(this._teamError(table) + ": repeated by a judge");
        seen.add(table);
      }
    }
    return issues;
  }

  _verifySimultaneousJudging() {
    var issues = []
    var maxSlots = Math.max(...this.assignments.map(function length(a) { return a.length; }))

    for (var slotIdx = 0; slotIdx < maxSlots; slotIdx++) {
      var tableNumbers = []

      for (var judgeAssignments of this.assignments) {
        if (slotIdx < judgeAssignments.length && judgeAssignments[slotIdx] !== -1) {
          tableNumbers.push(judgeAssignments[slotIdx])
        }
      }

      var seen = new Set()
      var duplicates = new Set()
      for (var num of tableNumbers) {
        if (seen.has(num)) {
          duplicates.add(num)
        }
        seen.add(num)
      }

      if (duplicates.size > 0) {
        issues.push(
          `In Slot ${slotIdx + 1}, tables ${Array.from(duplicates).join(", ")} are being judged simultaneously by multiple judges`,
        )
      }
    }

    return issues
  }

  _verifyNoJudgesStartAtSameTable() {
    var issues = []
    var firstSlotTables = new Map()

    for (var i = 0; i < this.assignments.length; i++) {
      var firstSlot = this.assignments[i][0]
      if (firstSlot && firstSlot !== -1) {
        var judge = this.system.judges[i]
        var judgeName = judge.name

        if (firstSlotTables.has(firstSlot)) {
          firstSlotTables.get(firstSlot).push(judgeName)
        } else {
          firstSlotTables.set(firstSlot, [judgeName])
        }
      }
    }

    for (var [tableNum, judges] of firstSlotTables.entries()) {
      if (judges.length > 1) {
        issues.push(`Multiple judges start at Table ${tableNum}: ${judges.join(", ")}`)
      }
    }

    return issues
  }

  _verifyJudgeWorkload() {
    var judgeCounts = {}

    for (var i = 0; i < this.assignments.length; i++) {
      var count = this.assignments[i].filter(function occupied(t) { return t !== -1; }).length
      var judge = this.system.judges[i]
      var judgeName = judge.name
      judgeCounts[judgeName] = count
    }

    var avgLoad = Object.values(judgeCounts).reduce(function sum(a, b) { return a + b; }, 0) / Object.keys(judgeCounts).length
    var maxDeviation = 2

    var issues = []
    for (var [judge, count] of Object.entries(judgeCounts)) {
      if (Math.abs(count - avgLoad) > maxDeviation) {
        issues.push(`Judge ${judge} has ${count} projects (average is ${avgLoad.toFixed(1)})`)
      }
    }

    return issues
  }

  /** @returns {object} Verification result, with messages in log. */
  verifyAll() {
    var judging = this._verifyJudgingCount();
    var repaired = judging.underJudgedProjects.length > 0;
    if (repaired && judging.overJudgedProjects.length === 0) {
      this._fixUnderJudgedProjects(judging.underJudgedProjects);
    }
    // All checks must run on the final schedule, including after repairs.
    var issues = this._verifyJudgingCount().issues
      .concat(this._verifySimultaneousJudging())
      .concat(this._verifyNoJudgesStartAtSameTable())
      .concat(this._verifyJudgeWorkload())
      .concat(this._verifyUniqueVisits());
    if (repaired && issues.length) {
      throw new Error(this._teamError(judging.underJudgedProjects[0].projectId) +
        ": invalid repaired schedule: " + issues.join("; "));
    }
    return { success: issues.length === 0, issues: issues,
      assignments: this.assignments, log: this.log.slice() };
  }
}

module.exports = { generateJudgingAssignments: generateJudgingAssignments,
  AssignmentGenerator: AssignmentGenerator, AssignmentVerifier: AssignmentVerifier };
