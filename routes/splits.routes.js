const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

/**
 * Helper: Verify that the authenticated user has access to the specified split group.
 * User must be either the owner of the group OR an accepted member.
 * If not found, not a member, or invitation still pending, returns null
 * (caller sends 404 to prevent group ID enumeration).
 */
async function verifyGroupAccess(groupId, userId, userEmail) {
  const parsedGroupId = parseInt(groupId, 10);
  if (isNaN(parsedGroupId) || parsedGroupId <= 0) return null;

  const query = `
    SELECT g.id, g.title, g.location, g.currency, g.description, g.owner_id, g.created_at, g.updated_at,
           gm.id AS member_id, gm.role AS member_role, gm.status AS member_status, gm.name AS member_name
    FROM split_groups g
    LEFT JOIN split_group_members gm
      ON gm.group_id = g.id
     AND (gm.user_id = $2 OR (gm.email IS NOT NULL AND LOWER(gm.email) = LOWER($3)))
    WHERE g.id = $1
    LIMIT 1;
  `;

  const result = await pool.query(query, [parsedGroupId, userId, userEmail || '']);
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const isOwner = row.owner_id === userId;
  const isAcceptedMember = Boolean(row.member_id && row.member_status === 'accepted');

  // Pending members and non-members do not receive group access
  if (!isOwner && !isAcceptedMember) {
    return null;
  }

  return {
    group: row,
    isOwner,
    currentMemberId: row.member_id,
    currentMemberName: row.member_name,
  };
}

/**
 * GET /api/splits/invitations
 * List all pending group invitations for the authenticated user
 */
router.get('/invitations', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    const query = `
      SELECT gm.id AS invitation_id, gm.group_id, g.title AS group_title, g.location, g.currency,
             u.name AS invited_by, gm.created_at
      FROM split_group_members gm
      JOIN split_groups g ON g.id = gm.group_id
      JOIN users u ON u.id = g.owner_id
      WHERE (gm.user_id = $1 OR (gm.email IS NOT NULL AND LOWER(gm.email) = LOWER($2)))
        AND gm.status = 'pending'
      ORDER BY gm.created_at DESC;
    `;

    const result = await pool.query(query, [userId, userEmail]);
    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error('Error fetching invitations:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invitations.',
    });
  }
});

/**
 * POST /api/splits/groups/:groupId/accept
 * Accept an invitation to join a split group
 */
router.post('/groups/:groupId/accept', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const userId = req.user.id;
    const userEmail = req.user.email;

    if (isNaN(groupId) || groupId <= 0) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    const result = await pool.query(
      `UPDATE split_group_members
       SET status = 'accepted', user_id = $1
       WHERE group_id = $2
         AND (user_id = $1 OR (email IS NOT NULL AND LOWER(email) = LOWER($3)))
         AND status = 'pending'
       RETURNING *;`,
      [userId, groupId, userEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No pending invitation found for this group.',
      });
    }

    return res.json({
      success: true,
      message: 'Invitation accepted successfully.',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Error accepting invitation:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to accept invitation.',
    });
  }
});

/**
 * POST /api/splits/groups/:groupId/decline
 * Decline a pending invitation to join a split group
 */
router.post('/groups/:groupId/decline', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const userId = req.user.id;
    const userEmail = req.user.email;

    if (isNaN(groupId) || groupId <= 0) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    const result = await pool.query(
      `UPDATE split_group_members
       SET status = 'declined'
       WHERE group_id = $2
         AND (user_id = $1 OR (email IS NOT NULL AND LOWER(email) = LOWER($3)))
         AND status = 'pending'
       RETURNING *;`,
      [userId, groupId, userEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No pending invitation found for this group.',
      });
    }

    return res.json({
      success: true,
      message: 'Invitation declined.',
    });
  } catch (err) {
    console.error('Error declining invitation:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to decline invitation.',
    });
  }
});

/**
 * GET /api/splits/groups
 * List all split groups accessible to the authenticated user (owned or accepted member)
 */
router.get('/groups', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    const query = `
      SELECT DISTINCT g.id, g.title, g.location, g.currency, g.description, g.owner_id, g.created_at, g.updated_at,
             (g.owner_id = $1) AS is_owner,
             (SELECT COUNT(*) FROM split_group_members WHERE group_id = g.id AND status = 'accepted')::int AS member_count,
             (SELECT COUNT(*) FROM split_expenses WHERE group_id = g.id)::int AS expense_count,
             COALESCE((SELECT SUM(amount) FROM split_expenses WHERE group_id = g.id), 0.00)::numeric AS total_outlay
      FROM split_groups g
      LEFT JOIN split_group_members gm ON gm.group_id = g.id
      WHERE g.owner_id = $1 OR (gm.status = 'accepted' AND (gm.user_id = $1 OR (gm.email IS NOT NULL AND LOWER(gm.email) = LOWER($2))))
      ORDER BY g.created_at DESC;
    `;

    const result = await pool.query(query, [userId, userEmail]);
    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error('Error fetching split groups:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve split groups.',
    });
  }
});

/**
 * POST /api/splits/groups
 * Create a new split group
 */
router.post('/groups', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const userName = req.user.name || 'You';
    const userEmail = req.user.email;

    const {
      title,
      location = '',
      currency = 'INR (₹)',
      description = '',
      participants = [],
    } = req.body;

    const cleanTitle = (title || '').trim();
    if (!cleanTitle) {
      return res.status(400).json({
        success: false,
        message: 'Ticket title cannot be empty.',
      });
    }

    await client.query('BEGIN');

    // 1. Create Group
    const groupInsert = `
      INSERT INTO split_groups (title, location, currency, description, owner_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const groupResult = await client.query(groupInsert, [
      cleanTitle,
      (location || '').trim(),
      (currency || 'INR (₹)').trim(),
      (description || '').trim(),
      userId,
    ]);
    const group = groupResult.rows[0];

    // 2. Add Owner as first member with accepted status
    const ownerMemberInsert = `
      INSERT INTO split_group_members (group_id, user_id, name, email, role, status, is_self)
      VALUES ($1, $2, $3, $4, 'owner', 'accepted', true)
      RETURNING *;
    `;
    const ownerMemberResult = await client.query(ownerMemberInsert, [
      group.id,
      userId,
      userName,
      userEmail,
    ]);
    const members = [ownerMemberResult.rows[0]];

    // 3. Add other participants
    if (Array.isArray(participants)) {
      for (const p of participants) {
        const pName = (p.name || '').trim();
        const pEmail = (p.email || '').trim().toLowerCase();
        const pStatus = (p.status || 'accepted').toLowerCase() === 'pending' ? 'pending' : 'accepted';

        // Skip self/duplicate owner
        if (!pName || pName.toLowerCase() === 'you' || (pEmail && pEmail === userEmail.toLowerCase())) {
          continue;
        }

        // Check if participant email matches an existing registered user
        let matchedUserId = null;
        if (pEmail) {
          const userCheck = await client.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
            [pEmail]
          );
          if (userCheck.rows.length > 0) {
            matchedUserId = userCheck.rows[0].id;
          }
        }

        const memberInsert = `
          INSERT INTO split_group_members (group_id, user_id, name, email, role, status, is_self)
          VALUES ($1, $2, $3, $4, 'member', $5, false)
          RETURNING *;
        `;
        const memberResult = await client.query(memberInsert, [
          group.id,
          matchedUserId,
          pName,
          pEmail || null,
          pStatus,
        ]);
        members.push(memberResult.rows[0]);
      }
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Split group created successfully.',
      data: {
        ...group,
        participants: members.map((m) => ({
          id: m.id,
          name: m.name,
          email: m.email,
          role: m.role,
          status: m.status,
          isSelf: m.user_id === userId,
          userId: m.user_id,
        })),
        expenses: [],
        settlements: [],
        settledDebtIds: [],
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating split group:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to create split group.',
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/splits/groups/:groupId
 * Retrieve details, members, expenses, and settlements for a specific group
 */
router.get('/groups/:groupId', authenticate, async (req, res) => {
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    const groupId = access.group.id;

    // 1. Members
    const membersResult = await pool.query(
      `SELECT id, user_id, name, email, role, status, (user_id = $2) AS is_self, created_at
       FROM split_group_members
       WHERE group_id = $1
       ORDER BY (role = 'owner') DESC, created_at ASC`,
      [groupId, req.user.id]
    );

    // 2. Expenses
    const expensesResult = await pool.query(
      `SELECT e.id, e.title, e.amount, e.paid_by_member_id, e.paid_by_name, e.expense_date, e.created_at, e.created_by_user_id
       FROM split_expenses e
       WHERE e.group_id = $1
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      [groupId]
    );

    // 3. Settlements
    const settlementsResult = await pool.query(
      `SELECT s.id, s.from_name, s.to_name, s.amount, s.debt_key, s.notes, s.settled_at
       FROM split_settlements s
       WHERE s.group_id = $1
       ORDER BY s.settled_at DESC`,
      [groupId]
    );

    const members = membersResult.rows.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      isSelf: m.is_self,
      userId: m.user_id,
    }));

    const memberNames = members.map((m) => m.name);

    const expenses = expensesResult.rows.map((e) => ({
      id: e.id,
      title: e.title,
      amount: parseFloat(e.amount),
      paidBy: e.paid_by_name,
      paidByMemberId: e.paid_by_member_id,
      date: e.expense_date,
      createdAt: e.created_at,
      createdByUserId: e.created_by_user_id,
      splitWith: memberNames,
    }));

    const settlements = settlementsResult.rows.map((s) => ({
      id: s.id,
      from: s.from_name,
      to: s.to_name,
      amount: parseFloat(s.amount),
      debtKey: s.debt_key,
      settledAt: s.settled_at,
      notes: s.notes,
    }));

    const settledDebtIds = Array.from(new Set(settlements.map((s) => s.debtKey).filter(Boolean)));

    return res.json({
      success: true,
      data: {
        id: access.group.id,
        title: access.group.title,
        location: access.group.location,
        currency: access.group.currency,
        description: access.group.description,
        ownerId: access.group.owner_id,
        isOwner: access.isOwner,
        createdAt: access.group.created_at,
        updatedAt: access.group.updated_at,
        participants: members,
        expenses,
        settlements,
        settledDebtIds,
      },
    });
  } catch (err) {
    console.error('Error fetching group details:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve group details.',
    });
  }
});

/**
 * PUT /api/splits/groups/:groupId
 * Update group title, location, currency, or description
 */
router.put('/groups/:groupId', authenticate, async (req, res) => {
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    const { title, location, currency, description } = req.body;
    const cleanTitle = (title || access.group.title).trim();

    if (!cleanTitle) {
      return res.status(400).json({
        success: false,
        message: 'Title cannot be empty.',
      });
    }

    const updateQuery = `
      UPDATE split_groups
      SET title = $1,
          location = COALESCE($2, location),
          currency = COALESCE($3, currency),
          description = COALESCE($4, description),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *;
    `;

    const result = await pool.query(updateQuery, [
      cleanTitle,
      location !== undefined ? location.trim() : null,
      currency !== undefined ? currency.trim() : null,
      description !== undefined ? description.trim() : null,
      access.group.id,
    ]);

    return res.json({
      success: true,
      message: 'Group updated successfully.',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Error updating split group:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update group.',
    });
  }
});

/**
 * DELETE /api/splits/groups/:groupId
 * Delete a split group (Owner only)
 */
router.delete('/groups/:groupId', authenticate, async (req, res) => {
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    if (!access.isOwner) {
      return res.status(403).json({
        success: false,
        message: 'Only the group owner can delete this group.',
      });
    }

    await pool.query('DELETE FROM split_groups WHERE id = $1', [access.group.id]);

    return res.json({
      success: true,
      message: 'Group successfully deleted.',
    });
  } catch (err) {
    console.error('Error deleting split group:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete group.',
    });
  }
});

/**
 * POST /api/splits/groups/:groupId/members
 * Invite or add a participant to a group
 */
router.post('/groups/:groupId/members', authenticate, async (req, res) => {
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    const { name, email, status = 'pending' } = req.body;
    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanStatus = status === 'accepted' ? 'accepted' : 'pending';

    if (!cleanName) {
      return res.status(400).json({
        success: false,
        message: 'Participant name is required.',
      });
    }

    // Check duplicate email in this group
    if (cleanEmail) {
      const dupCheck = await pool.query(
        'SELECT id FROM split_group_members WHERE group_id = $1 AND LOWER(email) = LOWER($2)',
        [access.group.id, cleanEmail]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'A participant with this email is already in the group.',
        });
      }
    }

    // Check if registered user exists
    let matchedUserId = null;
    if (cleanEmail) {
      const userCheck = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
      if (userCheck.rows.length > 0) {
        matchedUserId = userCheck.rows[0].id;
      }
    }

    const insertQuery = `
      INSERT INTO split_group_members (group_id, user_id, name, email, role, status, is_self)
      VALUES ($1, $2, $3, $4, 'member', $5, false)
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [
      access.group.id,
      matchedUserId,
      cleanName,
      cleanEmail || null,
      cleanStatus,
    ]);

    const m = result.rows[0];
    return res.status(201).json({
      success: true,
      message: 'Participant invited successfully.',
      data: {
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        status: m.status,
        isSelf: false,
        userId: m.user_id,
      },
    });
  } catch (err) {
    console.error('Error adding member:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to add participant.',
    });
  }
});

/**
 * POST /api/splits/groups/:groupId/expenses
 * Add an expense to the split group
 */
router.post('/groups/:groupId/expenses', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    const {
      title,
      amount,
      paid_by_name = 'You',
      paid_by_member_id,
      expense_date,
      split_with,
    } = req.body;

    const cleanTitle = (title || '').trim();
    const cleanAmount = parseFloat(amount);

    if (!cleanTitle) {
      return res.status(400).json({
        success: false,
        message: 'Expense title cannot be empty.',
      });
    }
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid expense amount greater than 0.',
      });
    }

    await client.query('BEGIN');

    // Resolve paid_by_member_id with strict group ownership check
    let memberId = null;
    let payerName = paid_by_name;

    if (paid_by_member_id) {
      const memberCheck = await client.query(
        'SELECT id, name FROM split_group_members WHERE id = $1 AND group_id = $2',
        [paid_by_member_id, access.group.id]
      );
      if (memberCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Member ID does not belong to this split group.',
        });
      }
      memberId = memberCheck.rows[0].id;
      payerName = memberCheck.rows[0].name;
    } else {
      if (paid_by_name === 'You' || paid_by_name === req.user.name) {
        memberId = access.currentMemberId;
        payerName = access.currentMemberName || 'You';
      } else {
        const memberLookup = await client.query(
          'SELECT id, name FROM split_group_members WHERE group_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
          [access.group.id, paid_by_name.trim()]
        );
        if (memberLookup.rows.length > 0) {
          memberId = memberLookup.rows[0].id;
          payerName = memberLookup.rows[0].name;
        }
      }
    }

    const cleanDate = expense_date || new Date().toISOString().split('T')[0];

    // Insert expense
    const insertExpense = `
      INSERT INTO split_expenses (group_id, title, amount, paid_by_member_id, paid_by_name, created_by_user_id, expense_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const expenseResult = await client.query(insertExpense, [
      access.group.id,
      cleanTitle,
      cleanAmount,
      memberId || null,
      payerName,
      req.user.id,
      cleanDate,
    ]);
    const expense = expenseResult.rows[0];

    // Identify participants sharing this expense
    let targetMembers = [];
    if (Array.isArray(split_with) && split_with.length > 0) {
      const namesList = split_with.map((n) => n.trim().toLowerCase());
      const res = await client.query(
        'SELECT id, name FROM split_group_members WHERE group_id = $1 AND LOWER(name) = ANY($2)',
        [access.group.id, namesList]
      );
      targetMembers = res.rows;
    }

    if (targetMembers.length === 0) {
      // Default to all active group members
      const allMembers = await client.query(
        "SELECT id, name FROM split_group_members WHERE group_id = $1 AND status = 'accepted'",
        [access.group.id]
      );
      targetMembers = allMembers.rows;
    }

    // Insert shares
    const count = targetMembers.length || 1;
    const shareAmount = Math.round((cleanAmount / count) * 100) / 100;

    for (const m of targetMembers) {
      await client.query(
        `INSERT INTO split_expense_shares (expense_id, member_id, share_amount)
         VALUES ($1, $2, $3)`,
        [expense.id, m.id, shareAmount]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Expense added to group successfully.',
      data: {
        id: expense.id,
        title: expense.title,
        amount: parseFloat(expense.amount),
        paidBy: expense.paid_by_name,
        paidByMemberId: expense.paid_by_member_id,
        date: expense.expense_date,
        createdAt: expense.created_at,
        splitWith: targetMembers.map((m) => m.name),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding group expense:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to record group expense.',
    });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/splits/groups/:groupId/expenses/:expenseId
 * Update a group expense (creator or group owner only)
 */
router.put('/groups/:groupId/expenses/:expenseId', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    const expenseId = parseInt(req.params.expenseId, 10);
    if (isNaN(expenseId) || expenseId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid expense ID' });
    }

    const check = await client.query(
      'SELECT id, created_by_user_id FROM split_expenses WHERE id = $1 AND group_id = $2',
      [expenseId, access.group.id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found in this group.',
      });
    }

    const expense = check.rows[0];
    if (!access.isOwner && expense.created_by_user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied. Only the expense creator or group owner can update this expense.',
      });
    }

    const { title, amount } = req.body;
    const cleanTitle = (title || '').trim();
    const cleanAmount = parseFloat(amount);

    if (!cleanTitle || isNaN(cleanAmount) || cleanAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid title and positive amount required.' });
    }

    await client.query('BEGIN');

    await client.query(
      'UPDATE split_expenses SET title = $1, amount = $2 WHERE id = $3',
      [cleanTitle, cleanAmount, expenseId]
    );

    // Recalculate shares
    const sharesRes = await client.query(
      'SELECT id FROM split_expense_shares WHERE expense_id = $1',
      [expenseId]
    );
    const count = sharesRes.rows.length || 1;
    const shareAmount = Math.round((cleanAmount / count) * 100) / 100;

    await client.query(
      'UPDATE split_expense_shares SET share_amount = $1 WHERE expense_id = $2',
      [shareAmount, expenseId]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Expense updated successfully.',
      data: { id: expenseId, title: cleanTitle, amount: cleanAmount },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating expense:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update expense.' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/splits/groups/:groupId/expenses/:expenseId
 * Delete a group expense (creator or group owner only)
 */
router.delete('/groups/:groupId/expenses/:expenseId', authenticate, async (req, res) => {
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    const expenseId = parseInt(req.params.expenseId, 10);
    if (isNaN(expenseId) || expenseId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid expense ID' });
    }

    const check = await pool.query(
      'SELECT id, created_by_user_id FROM split_expenses WHERE id = $1 AND group_id = $2',
      [expenseId, access.group.id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found in this group.',
      });
    }

    const expense = check.rows[0];
    if (!access.isOwner && expense.created_by_user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied. Only the expense creator or group owner can remove this expense.',
      });
    }

    await pool.query('DELETE FROM split_expenses WHERE id = $1', [expenseId]);

    return res.json({
      success: true,
      message: 'Expense successfully deleted.',
    });
  } catch (err) {
    console.error('Error deleting expense:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete expense.',
    });
  }
});

/**
 * POST /api/splits/groups/:groupId/settlements
 * Record a payment / debt settlement between two group members
 */
router.post('/groups/:groupId/settlements', authenticate, async (req, res) => {
  try {
    const access = await verifyGroupAccess(req.params.groupId, req.user.id, req.user.email);
    if (!access) {
      return res.status(404).json({
        success: false,
        message: 'Group not found.',
      });
    }

    const { from_name, to_name, from_member_id, to_member_id, amount, debt_key, notes = '' } = req.body;

    const cleanFrom = (from_name || '').trim();
    const cleanTo = (to_name || '').trim();
    const cleanAmount = parseFloat(amount);

    if (!cleanFrom || !cleanTo) {
      return res.status(400).json({
        success: false,
        message: 'Both debtor (from) and creditor (to) names are required.',
      });
    }
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid positive settlement amount required.',
      });
    }

    // Validate member IDs if provided
    let fromId = null;
    let toId = null;

    if (from_member_id) {
      const checkFrom = await pool.query(
        'SELECT id, name FROM split_group_members WHERE id = $1 AND group_id = $2',
        [from_member_id, access.group.id]
      );
      if (checkFrom.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'from_member_id does not belong to this group.',
        });
      }
      fromId = checkFrom.rows[0].id;
    }

    if (to_member_id) {
      const checkTo = await pool.query(
        'SELECT id, name FROM split_group_members WHERE id = $1 AND group_id = $2',
        [to_member_id, access.group.id]
      );
      if (checkTo.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'to_member_id does not belong to this group.',
        });
      }
      toId = checkTo.rows[0].id;
    }

    if (!fromId || !toId) {
      const memberRows = await pool.query(
        'SELECT id, name FROM split_group_members WHERE group_id = $1 AND (LOWER(name) = LOWER($2) OR LOWER(name) = LOWER($3))',
        [access.group.id, cleanFrom, cleanTo]
      );
      if (!fromId) {
        const found = memberRows.rows.find((m) => m.name.toLowerCase() === cleanFrom.toLowerCase());
        if (found) fromId = found.id;
      }
      if (!toId) {
        const found = memberRows.rows.find((m) => m.name.toLowerCase() === cleanTo.toLowerCase());
        if (found) toId = found.id;
      }
    }

    const insertQuery = `
      INSERT INTO split_settlements (group_id, from_member_id, from_name, to_member_id, to_name, amount, debt_key, settled_by_user_id, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      access.group.id,
      fromId,
      cleanFrom,
      toId,
      cleanTo,
      cleanAmount,
      debt_key || null,
      req.user.id,
      (notes || '').trim(),
    ]);

    const settlement = result.rows[0];

    return res.status(201).json({
      success: true,
      message: 'Settlement recorded successfully.',
      data: {
        id: settlement.id,
        from: settlement.from_name,
        to: settlement.to_name,
        amount: parseFloat(settlement.amount),
        debtKey: settlement.debt_key,
        settledAt: settlement.settled_at,
        notes: settlement.notes,
      },
    });
  } catch (err) {
    console.error('Error recording settlement:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to record settlement.',
    });
  }
});

module.exports = router;
