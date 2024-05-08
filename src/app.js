// Import necessary modules
const express = require("express");
const bodyParser = require("body-parser");
const { Op, literal } = require("sequelize");
const { sequelize, Profile, Contract, Job } = require("./model");
const { getProfile } = require("./middleware/getProfile");

// Initialize Express app
const app = express();

// Middleware setup
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * FIX ME!
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const profileId = req.get("profile_id");

  const contract = await Contract.findOne({
    where: { id, ClientId: profileId },
  });

  if (!contract) return res.status(404).end();

  res.json(contract);
});

// Get all contracts belonging to a user (client or contractor), excluding terminated contracts
app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const profileId = req.get("profile_id");

  const contracts = await Contract.findAll({
    where: {
      [Op.or]: [{ ClientId: profileId }, { ContractorId: profileId }],
      status: {
        [Op.ne]: "terminated",
      },
    },
  });

  if (contracts.length === 0) return res.status(404).end();

  res.json(contracts);
});

// Get all unpaid jobs for a user (client or contractor), for active contracts only
app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get("models");
  const profileId = req.get("profile_id");

  const unpaidJobs = await Job.findAll({
    where: {
      paid: null,
    },
    include: {
      model: Contract,
      attributes: [], // Exclude all attributes from the Contract model
      where: {
        [Op.or]: [{ ClientId: profileId }, { ContractorId: profileId }],
        status: "in_progress",
      },
    },
  });

  if (unpaidJobs.length === 0) return res.status(404).end();

  res.json(unpaidJobs);
});

// Pay for a job, transferring funds from client's balance to contractor's balance
app.post("/jobs/:job_id/pay", async (req, res) => {
  const { Profile, Job } = req.app.get("models");
  const profileId = req.get("profile_id");
  const jobId = req.params.job_id;

  // Fetch the job including its contract details
  const job = await Job.findByPk(jobId, { include: Contract });

  // Ensure the requester is the client associated with the job
  if (job.Contract.ClientId != profileId) {
    return res.status(403).json({
      error: "Forbidden: You are not the client associated with this job",
    });
  }

  // Check if the job exists and is unpaid
  if (!job || job.paid) {
    return res.status(404).json({ error: "Job not found or already paid" });
  }

  // Ensure the client has sufficient balance
  const client = await Profile.findByPk(profileId);
  if (client.balance < job.price) {
    return res.status(400).json({ error: "Insufficient balance" });
  }

  // Update balances in a transaction to ensure data consistency
  await sequelize.transaction(async (t) => {
    await client.decrement("balance", { by: job.price, transaction: t });
    const contractor = await Profile.findByPk(job.Contract.ContractorId);
    await contractor.increment("balance", { by: job.price, transaction: t });
    await job.update(
      { paid: true, paymentDate: new Date() },
      { transaction: t }
    );
  });

  // Payment successful
  return res.json({ message: "Payment successful" });
});

// Deposit money into the balance of a client
app.post("/balances/deposit/:userId", async (req, res) => {
  const { Profile, Job, Contract } = req.app.get("models"); // Include Contract model
  const userId = req.params.userId;
  const profileId = req.get("profile_id");
  const depositAmount = req.body.amount;

  // Check if the user making the request is the client associated with the deposit
  if (userId !== profileId) {
    return res.status(403).json({
      error: "Forbidden: You are not authorized to perform this action",
    });
  }

  // Check if the user exists
  const client = await Profile.findByPk(userId);
  if (!client) {
    return res.status(404).json({ error: "User not found" });
  }

  // Check if the user is a client
  if (client.type !== "client") {
    return res.status(400).json({ error: "Only clients can make deposits" });
  }

  // Check deposit amount limit
  const totalJobsToPay = await Job.sum("price", {
    where: { paid: null },
    include: { model: Contract, where: { ClientId: userId } }, // Include Contract model and filter by ClientId
  });
  console.log("Total Jobs to Pay:", totalJobsToPay); // Log total jobs to pay

  const depositLimit = totalJobsToPay * 0.25;
  console.log("Deposit Limit:", depositLimit); // Log deposit limit

  if (depositAmount > depositLimit) {
    return res
      .status(400)
      .json({ error: "Deposit amount exceeds 25% of total jobs to pay" });
  }

  // Update client's balance
  await client.increment("balance", { by: depositAmount });

  res.json({ message: "Deposit successful" });
});

// Get the profession that earned the most money within a specified time range
app.get("/admin/best-profession", async (req, res) => {
  const { Profile, Contract, Job } = req.app.get("models");
  const { start, end } = req.query;

  const bestProfession = await Job.findAll({
    attributes: [
      // Using sequelize.literal for custom SQL statements to access nested attributes
      [sequelize.literal("`Contract->Contractor`.`profession`"), "profession"],
      [sequelize.fn("SUM", sequelize.col("price")), "totalEarned"], // Summing the price attribute
    ],
    include: [
      {
        model: Contract,
        as: "Contract",
        attributes: [],
        include: {
          model: Profile,
          as: "Contractor",
          attributes: [],
        },
      },
    ],
    where: {
      paymentDate: {
        [Op.between]: [start, end], // Filtering based on paymentDate within the specified range
      },
      paid: true, // Considering only paid jobs
    },
    group: [sequelize.literal("`Contract->Contractor`.`profession`")], // Grouping by profession
    order: [[sequelize.literal("totalEarned"), "DESC"]], // Ordering by totalEarned in descending order
    limit: 1, // Limiting the result to 1 record
  });

  const result = bestProfession.map((item) => ({
    profession: item.dataValues.profession,
    totalEarned: item.dataValues.totalEarned,
  }));

  res.json(result);
});

// Endpoint to get the best clients based on the amount paid for jobs within a specific time period
app.get("/admin/best-clients", async (req, res) => {
  const { start, end, limit = 2 } = req.query;

  // Query jobs paid within the specified time period, ordered by amount paid
  const jobs = await Job.findAll({
    where: {
      paid: true,
      paymentDate: {
        [Op.between]: [new Date(start), new Date(end)],
      },
    },
    include: [
      {
        model: Contract,
        include: {
          model: Profile,
          as: "Client",
        },
      },
    ],
    order: [["price", "DESC"]],
    limit,
  });

  // Extract relevant information about the clients from the retrieved job data
  const clients = jobs.map((job) => ({
    id: job.Contract.Client.id,
    fullName: `${job.Contract.Client.firstName} ${job.Contract.Client.lastName}`,
    paid: job.price,
  }));

  res.json(clients);
});

module.exports = app;
