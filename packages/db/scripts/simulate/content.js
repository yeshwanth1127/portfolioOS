/** Names and work content for the simulator, per organisation slug (with a generic fallback). */

export const FIRST = ['Aarav', 'Divya', 'Karan', 'Meera', 'Rohit', 'Sneha', 'Vikram', 'Ananya', 'Arjun', 'Kavya', 'Pranav', 'Lakshmi', 'Siddharth', 'Nithya', 'Harish', 'Pooja', 'Gokul', 'Revathi', 'Naveen', 'Shalini', 'Aditya', 'Keerthana', 'Manoj', 'Priya', 'Suresh', 'Janani', 'Vignesh', 'Aishwarya', 'Rahul', 'Deepa', 'Bharath', 'Swathi', 'Dinesh', 'Gayathri', 'Ashwin', 'Ramya', 'Kishore', 'Bhavya', 'Sanjay', 'Hema', 'Ajay', 'Nandhini', 'Prakash', 'Sowmya', 'Tarun', 'Vidya'];
export const LAST = ['Kumar', 'Iyer', 'Reddy', 'Nair', 'Sharma', 'Raman', 'Pillai', 'Menon', 'Rao', 'Krishnan', 'Subramanian', 'Gupta', 'Shetty', 'Varma', 'Balaji', 'Murthy', 'Prasad', 'Natarajan', 'Hegde', 'Chandran'];

/** Teams per organisation: [team name, focus words used in task titles]. */
export const TEAMS = {
  tms: [['Implementation', 'implementation'], ['Support desk', 'support']],
  uatc: [['Training delivery', 'training'], ['XR studio', 'studio']],
  s3dx: [['Design engineering', 'design'], ['Simulation & analysis', 'analysis']],
  pats: [['Field operations', 'field'], ['Fleet & maintenance', 'fleet']],
  sai: [['Incubation', 'incubation'], ['Programmes & grants', 'programmes']],
  comms: [['Creative studio', 'creative'], ['Digital & social', 'digital']],
  scale: [['Programme delivery', 'programmes'], ['Industry relations', 'industry']],
};
export const GENERIC_TEAMS = [['Delivery', 'delivery'], ['Operations', 'operations']];

/** Projects per organisation: [name, task titles]. */
export const PROJECTS = {
  tms: [
    ['College ERP rollout — phase 2', ['Map asset categories', 'Tag lab equipment with QR', 'Train admin staff', 'Configure AMC reminders', 'Migrate complaint history', 'Set escalation matrix', 'UAT with college IT', 'Go-live checklist']],
    ['Hospital asset audit', ['Survey ICU assets', 'QR-tag biomedical devices', 'Reconcile asset register', 'Share audit findings', 'Fix duplicate asset IDs', 'Photograph tagged assets']],
    ['Complaint desk revamp', ['Redesign complaint form', 'Set SLA timers', 'Weekly closure review', 'Publish resolution dashboard', 'Call back pending complainants']],
  ],
  uatc: [
    ['Unreal certification batch', ['Prepare lab machines', 'Run orientation session', 'Conduct module assessment', 'Collect learner feedback', 'Issue certificates', 'Update attendance sheet']],
    ['VR safety training — client pilot', ['Storyboard scenarios', 'Build warehouse scene', 'Client walkthrough', 'Fix interaction bugs', 'Optimise frame rate', 'Deliver pilot build']],
    ['Faculty development programme', ['Finalise FDP agenda', 'Invite partner colleges', 'Run hands-on lab', 'Share recordings', 'Collect FDP feedback']],
  ],
  s3dx: [
    ['EV battery enclosure design', ['Concept sketches', 'CAD model revision', 'FEA on mounting brackets', 'Design review with client', 'Release drawings', 'Update BOM']],
    ['Aero bracket redesign', ['Gather load cases', 'Topology optimisation run', 'Update GD&T', 'First-article checklist', 'Weight reduction study']],
    ['CAD training cohort', ['Prepare SolidWorks exercises', 'Run weekend session', 'Grade assignments', 'Collect feedback']],
  ],
  pats: [
    ['Rabi spraying season', ['Schedule village demos', 'Confirm FPO bookings', 'Pilot roster for the week', 'Spray plots — north cluster', 'Collect payments from FPOs', 'Upload flight logs']],
    ['Drone maintenance programme', ['Battery health check', 'Replace worn propellers', 'Firmware updates', 'Log flight hours', 'Calibrate spray nozzles']],
    ['Enterprise contract — sugar mill', ['Site survey', 'Prepare proposal', 'Pricing approval', 'Sign MoU', 'Plan first spray cycle']],
  ],
  sai: [
    ['Cohort 5 incubation', ['Shortlist applications', 'Founder interviews', 'Assign mentors', 'Demo day plan', 'Collect monthly MIS', 'Review startup milestones']],
    ['Grant applications drive', ['Identify open grants', 'Draft BIRAC application', 'Review pitch decks', 'Submit applications', 'Track grant status']],
    ['Power On Me event', ['Book venue', 'Confirm speakers', 'Promote on LinkedIn', 'Registration follow-ups', 'Post-event survey']],
  ],
  comms: [
    ['Brand refresh campaign', ['Moodboard', 'Social creatives batch', 'Website hero update', 'Press kit', 'Review with leadership', 'Brochure redesign']],
    ['Annual day coverage', ['Shot list', 'Photo editing', 'Highlight reel', 'Publish album', 'Press release']],
    ['Lead generation sprint', ['Landing page copy', 'Ad creatives', 'Weekly leads report', 'Hand-off to sales', 'Email newsletter']],
  ],
  scale: [
    ['Industry certification programme', ['Finalise curriculum', 'Onboard trainers', 'Enrol learners', 'Run batch session', 'Placement drive', 'Mock interviews']],
    ['Corporate innovation lab', ['Partner outreach', 'Problem statement workshop', 'Prototype sprint', 'Showcase day', 'Partner MoU follow-up']],
    ['Learner support desk', ['Set up helpdesk', 'Weekly mentoring hours', 'Track learner progress', 'Resolve learner queries']],
  ],
};
export const GENERIC_PROJECTS = [
  ['Quarterly delivery plan', ['Kick-off meeting', 'Draft plan', 'Review with manager', 'Execute weekly actions', 'Weekly review', 'Close-out report']],
  ['Process improvement', ['Map current process', 'Identify bottlenecks', 'Pilot new checklist', 'Train team', 'Measure results']],
  ['Client engagement', ['Discovery call', 'Proposal', 'Follow-up', 'Contract', 'Onboarding']],
];

export const COMMENTS = ['Started on this today.', 'Waiting on inputs from the client.', 'Draft shared, please review.', 'Done — attached the final version.', 'Need one more day on this.', 'Blocked on approval.', 'Updated as discussed.', 'Looks good, go ahead.', 'Can we move this to next week?', 'Following up tomorrow morning.', 'Halfway through, no blockers.', 'Shared with the client for sign-off.', 'Fixed the issues from review.', 'Checked with the team, all clear.'];
export const REVIEW_OK = ['Reviewed — looks good.', 'Approved, closing this.', 'Good work, done.', 'Checked and closed.'];
export const REVIEW_BACK = ['A few changes needed, see notes.', 'Please recheck the numbers before closing.', 'Missing the attachment, please add.'];
export const UPDATES = ['Good progress this week; main deliverables on track.', 'Two tasks slipped because of client delays; recovering next week.', 'Milestone review done; next phase starts Monday.', 'Team focused on closing overdue items this week.', 'Client feedback received and incorporated.', 'Resourcing tight this week; prioritised critical tasks.', 'On track. Next week: final reviews and hand-over.'];
export const VISITS = ['Client site visit', 'Partner meeting', 'Campus visit', 'Vendor review', 'Field inspection'];
