'use strict';
// Which work may leave the building. One decision per AREA of the team:
//   local = runs on a model on one of our own PCs (nothing leaves the network)
//   cloud = the Claude / GitHub pipeline (Dev Console: issue -> pull request, the owner merges)
// Dev and QA get the cloud pipeline because code work needs the strongest model (see the benchmark: the local 8B model
// resolved 1 of 8 real tasks, Claude 8 of 8). Everything else stays local: lower effort, higher confidentiality.
//
// confidentialAreas can NEVER be routed to the cloud, even if someone edits `lanes` - the router checks this list
// last and forces 'local'. Edit with care.
//
// The same table is mirrored in the website's team-data.js for the 3D page; bridge.test.js and the site's tests
// compare them so they can't drift apart.
module.exports = {
  defaultLane: 'local',
  lanes: {
    dev: 'cloud',
    qa: 'cloud',
    design: 'local',
    marketing: 'local',
    sales: 'local',
    copy: 'local',
    strategy: 'local',
    security: 'local',
    management: 'local',
    legal: 'local',
    compliance: 'local',
    verify: 'local',        // Vera checks fixes with the local model: the code she reads and the notes she writes stay on our PCs
  },
  confidentialAreas: ['legal', 'compliance', 'sales', 'strategy', 'security', 'management'],
};
