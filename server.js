// server.js
import fastify from 'fastify';
import cors from '@fastify/cors';
import bcrypt from 'bcryptjs';
import pkg from 'pg';

const { Pool } = pkg;

// ---- CONFIGURAÇÃO DO FASTIFY ----
const app = fastify({ logger: true });

await app.register(cors, { origin: true });

// ---- CONEXÃO FIXA COM O POSTGRES ----
const pool = new Pool({
  connectionString: "postgres://postgres:admin123@localhost:5432/barberscheduler_db"
});

async function dbQuery(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// ---- HELPERS ----
const SALT_ROUNDS = 10;

function normalizePhone(phone) {
  return phone?.replace(/\D/g, '') || null;
}

async function hasOverlappingAppointment(professionalId, startTime, endTime) {
  const query = `
    SELECT 1
    FROM appointments
    WHERE professional_id = $1
      AND status NOT IN ('CANCELLED', 'NO_SHOW')
      AND tstzrange(start_time, end_time) && tstzrange($2, $3)
    LIMIT 1;
  `;
  const { rows } = await dbQuery(query, [professionalId, startTime, endTime]);
  return rows.length > 0;
}

async function getServiceDetails(professionalId, serviceId) {
  const query = `
    SELECT
      s.duration_min,
      s.price_cents,
      ps.custom_duration_min,
      ps.custom_price_cents
    FROM services s
    LEFT JOIN professional_services ps
      ON ps.service_id = s.id AND ps.professional_id = $1
    WHERE s.id = $2;
  `;
  const { rows } = await dbQuery(query, [professionalId, serviceId]);
  if (!rows.length) return null;

  const s = rows[0];

  return {
    durationMin: s.custom_duration_min ?? s.duration_min,
    priceCents: s.custom_price_cents ?? s.price_cents,
  };
}

// ---- ROTAS ----

// Health check
app.get('/health', async () => ({ status: 'ok' }));

//
// AUTH
//

app.post('/auth/register', async (request, reply) => {
  try {
    const { fullName, email, phone, password, role } = request.body || {};

    if (!fullName || !email || !phone || !password) {
      return reply.status(400).send({ error: "Campos obrigatórios não enviados." });
    }

    const normalizedPhone = normalizePhone(phone);

    const exists = await dbQuery(
      "SELECT id FROM users WHERE email = $1 OR phone = $2",
      [email, normalizedPhone]
    );

    if (exists.rows.length > 0) {
      return reply.status(409).send({ error: "E-mail ou telefone já cadastrados." });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const query = `
      INSERT INTO users (full_name, email, phone, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, full_name, email, phone, role, created_at;
    `;

    const { rows } = await dbQuery(query, [
      fullName,
      email,
      normalizedPhone,
      passwordHash,
      role ?? "CLIENTE",
    ]);

    return reply.status(201).send({ user: rows[0] });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: "Erro ao registrar usuário." });
  }
});

app.post('/auth/login', async (request, reply) => {
  try {
    const { phone, password } = request.body || {};

    if (!phone || !password) {
      return reply
        .status(400)
        .send({ error: "Telefone e senha são obrigatórios." });
    }

    const normalizedPhone = normalizePhone(phone);

    const q = `
      SELECT id, full_name, email, phone, role, password_hash
      FROM users
      WHERE phone = $1
      LIMIT 1;
    `;
    const { rows } = await dbQuery(q, [normalizedPhone]);

    if (!rows.length) {
      return reply.status(401).send({ error: "Telefone ou senha inválidos." });
    }

    const user = rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return reply.status(401).send({ error: "Telefone ou senha inválidos." });
    }

    delete user.password_hash;

    // Se for um barbeiro, carrega também o registro de professional
    if (user.role === 'BARBER') {
      const profQuery = `
        SELECT id, barbershop_id, bio, is_active, is_master
        FROM professionals
        WHERE user_id = $1
        LIMIT 1;
      `;

      const { rows: profRows } = await dbQuery(profQuery, [user.id]);

      if (profRows.length) {
        const prof = profRows[0];
        user.professional = {
          id: prof.id,
          barbershop_id: prof.barbershop_id,
          bio: prof.bio,
          is_active: prof.is_active,
          is_master: prof.is_master,
        };
      }
    }

    return reply.send({ user });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: "Erro ao realizar login." });
  }
});


//
// BARBEARIAS, PROFISSIONAIS, SERVIÇOS
//

app.get('/barbershops', async (_, reply) => {
  try {
    const { rows } = await dbQuery(`SELECT * FROM barbershops ORDER BY name`);
    reply.send({ barbershops: rows });
  } catch (err) {
    reply.status(500).send({ error: "Erro ao buscar barbearias." });
  }
});

app.get('/barbershops/:id/professionals', async (request, reply) => {
  try {
    const id = Number(request.params.id);

    const query = `
      SELECT p.id, p.bio, p.is_active, p.is_master,
             u.full_name, u.phone
      FROM professionals p
      JOIN users u ON u.id = p.user_id
      WHERE p.barbershop_id = $1
      ORDER BY u.full_name
    `;

    const { rows } = await dbQuery(query, [id]);

    reply.send({ professionals: rows });
  } catch (err) {
    reply.status(500).send({ error: "Erro ao buscar profissionais." });
  }
});

app.get('/barbershops/:id/services', async (request, reply) => {
  try {
    const id = Number(request.params.id);

    const { rows } = await dbQuery(
      `SELECT * FROM services WHERE barbershop_id = $1 AND is_active = TRUE`,
      [id]
    );

    reply.send({ services: rows });
  } catch (err) {
    reply.status(500).send({ error: "Erro ao buscar serviços." });
  }
});

//
// AGENDAMENTOS
//

app.post('/appointments', async (request, reply) => {
  try {
    const {
      clientId,
      professionalId,
      serviceId,
      startTime,
      notes
    } = request.body || {};

    if (!clientId || !professionalId || !serviceId || !startTime) {
      return reply.status(400).send({ error: "Dados obrigatórios faltando." });
    }

    const details = await getServiceDetails(professionalId, serviceId);

    if (!details) {
      return reply.status(400).send({ error: "Serviço inválido." });
    }

    const { durationMin, priceCents } = details;

    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMin * 60000);

    const conflict = await hasOverlappingAppointment(
      professionalId,
      start.toISOString(),
      end.toISOString()
    );

    if (conflict) {
      return reply.status(409).send({ error: "Horário indisponível." });
    }

    const insert = `
      INSERT INTO appointments
        (client_id, professional_id, service_id, start_time, end_time, status, total_price_cents, notes)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
      RETURNING *;
    `;

    const { rows } = await dbQuery(insert, [
      clientId,
      professionalId,
      serviceId,
      start,
      end,
      priceCents,
      notes ?? null
    ]);

    reply.status(201).send({ appointment: rows[0] });

  } catch (err) {
    reply.status(500).send({ error: "Erro ao criar agendamento." });
  }
});



// Agendamentos de um cliente
app.get('/clients/:id/appointments', async (request, reply) => {
  try {
    const clientId = Number(request.params.id);

    const query = `
      SELECT
        a.id,
        a.start_time,
        a.end_time,
        a.status,
        a.total_price_cents,
        s.name AS service_name,
        u.full_name AS professional_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN professionals p ON p.id = a.professional_id
      JOIN users u ON u.id = p.user_id
      WHERE a.client_id = $1
      ORDER BY a.start_time DESC;
    `;

    const { rows } = await dbQuery(query, [clientId]);

    return reply.send({ appointments: rows });
  } catch (err) {
    request.log.error(err);
    return reply
      .status(500)
      .send({ error: 'Erro ao buscar agendamentos do cliente.' });
  }
});

// Agendamentos de HOJE de um profissional (tela Home do barbeiro)
app.get('/professionals/:id/appointments/today', async (request, reply) => {
  try {
    const professionalId = Number(request.params.id);

    if (!professionalId) {
      return reply
        .status(400)
        .send({ error: 'ID do profissional inválido.' });
    }

    const query = `
      SELECT
        a.id,
        a.start_time,
        a.end_time,
        a.status,
        a.total_price_cents,
        s.name  AS service_name,
        u.full_name AS client_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN users u ON u.id = a.client_id
      WHERE
        a.professional_id = $1
        AND a.status NOT IN ('CANCELLED', 'NO_SHOW')
        AND a.start_time::date = CURRENT_DATE
      ORDER BY a.start_time ASC;
    `;

    const { rows } = await dbQuery(query, [professionalId]);

    return reply.send({ appointments: rows });
  } catch (err) {
    request.log.error(err);
    return reply
      .status(500)
      .send({ error: 'Erro ao buscar agendamentos do profissional.' });
  }
});

// CANCELAR APPOINTMENT
app.patch("/appointments/:id/cancel", async (req, reply) => {
  const { id } = req.params;

  try {
    const result = await dbQuery(
      `UPDATE appointments
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rowCount === 0) {
      return reply.status(404).send({ error: "Agendamento não encontrado." });
    }

    return { success: true, appointment: result.rows[0] };
  } catch (err) {
    console.error(err);
    reply.status(500).send({ error: "Erro ao cancelar agendamento." });
  }
});


// ---- INICIAR SERVIDOR ----

const PORT = 3333;

app.listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`🚀 API rodando em http://localhost:${PORT}`))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
