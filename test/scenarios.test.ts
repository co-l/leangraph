import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphDatabase } from "../src/db";
import { Executor, ExecutionResult } from "../src/executor";

/**
 * Real-world scenario tests - Multi-step workflows that simulate actual usage patterns
 */
describe("Real-World Scenarios", () => {
  let db: GraphDatabase;
  let executor: Executor;

  beforeEach(() => {
    db = new GraphDatabase(":memory:");
    db.initialize();
    executor = new Executor(db);
  });

  afterEach(() => {
    db.close();
  });

  function exec(cypher: string, params: Record<string, unknown> = {}): ExecutionResult {
    const result = executor.execute(cypher, params);
    if (!result.success) {
      throw new Error(`Query failed: ${result.error.message}`);
    }
    return result;
  }

  describe("Social Network", () => {
    it("builds a friend network and finds connections", () => {
      // Create users
      exec("CREATE (u:User {name: 'Alice', email: 'alice@example.com', joined: 2020})");
      exec("CREATE (u:User {name: 'Bob', email: 'bob@example.com', joined: 2021})");
      exec("CREATE (u:User {name: 'Charlie', email: 'charlie@example.com', joined: 2021})");
      exec("CREATE (u:User {name: 'Diana', email: 'diana@example.com', joined: 2022})");
      exec("CREATE (u:User {name: 'Eve', email: 'eve@example.com', joined: 2022})");

      // Get user IDs for creating relationships
      const users = exec("MATCH (u:User) RETURN u.name, id(u)").data;
      const userIds: Record<string, string> = {};
      for (const row of users) {
        userIds[row["u.name"] as string] = row.id as string;
      }

      // Create friendships via raw DB (since we need existing node IDs)
      db.insertEdge("f1", "FRIENDS", userIds["Alice"], userIds["Bob"], { since: 2021 });
      db.insertEdge("f2", "FRIENDS", userIds["Bob"], userIds["Charlie"], { since: 2021 });
      db.insertEdge("f3", "FRIENDS", userIds["Charlie"], userIds["Diana"], { since: 2022 });
      db.insertEdge("f4", "FRIENDS", userIds["Alice"], userIds["Eve"], { since: 2022 });

      // Find Alice's direct friends
      const aliceFriends = exec(`
        MATCH (a:User {name: 'Alice'})-[:FRIENDS]->(friend:User) 
        RETURN friend.name
      `);
      expect(aliceFriends.data.map((r) => r["friend.name"])).toContain("Bob");
      expect(aliceFriends.data.map((r) => r["friend.name"])).toContain("Eve");

      // Count total friendships
      const friendshipCount = exec("MATCH (a:User)-[:FRIENDS]->(b:User) RETURN COUNT(a)");
      expect(friendshipCount.data[0].count).toBe(4);

      // Find users who joined in 2021
      const users2021 = exec("MATCH (u:User) WHERE u.joined = 2021 RETURN u.name");
      expect(users2021.data).toHaveLength(2);
    });

    it("handles user blocking and unblocking", () => {
      exec("CREATE (u:User {name: 'Alice', status: 'active'})");
      exec("CREATE (u:User {name: 'Troll', status: 'active'})");

      const users = exec("MATCH (u:User) RETURN u.name, id(u)").data;
      const userIds: Record<string, string> = {};
      for (const row of users) {
        userIds[row["u.name"] as string] = row.id as string;
      }

      // Alice blocks Troll
      db.insertEdge("b1", "BLOCKS", userIds["Alice"], userIds["Troll"], { 
        reason: "spam", 
        blockedAt: "2024-01-15" 
      });

      // Verify block exists
      const blocks = exec("MATCH (a:User {name: 'Alice'})-[:BLOCKS]->(blocked:User) RETURN blocked.name");
      expect(blocks.data).toHaveLength(1);
      expect(blocks.data[0]["blocked.name"]).toBe("Troll");

      // Remove block
      db.deleteEdge("b1");

      // Verify block is gone
      const blocksAfter = exec("MATCH (a:User {name: 'Alice'})-[:BLOCKS]->(blocked:User) RETURN blocked.name");
      expect(blocksAfter.data).toHaveLength(0);
    });
  });

  describe("E-commerce", () => {
    it("models products, categories, and purchases", () => {
      // Create categories
      exec("CREATE (c:Category {name: 'Electronics', slug: 'electronics'})");
      exec("CREATE (c:Category {name: 'Books', slug: 'books'})");
      exec("CREATE (c:Category {name: 'Clothing', slug: 'clothing'})");

      // Create products
      exec("CREATE (p:Product {name: 'Laptop', price: 999.99, stock: 50, sku: 'ELEC-001'})");
      exec("CREATE (p:Product {name: 'Headphones', price: 149.99, stock: 200, sku: 'ELEC-002'})");
      exec("CREATE (p:Product {name: 'TypeScript Handbook', price: 39.99, stock: 100, sku: 'BOOK-001'})");
      exec("CREATE (p:Product {name: 'T-Shirt', price: 24.99, stock: 500, sku: 'CLTH-001'})");

      // Create customer
      exec("CREATE (c:Customer {name: 'John Doe', email: 'john@example.com', tier: 'gold'})");

      // Link products to categories
      const categories = exec("MATCH (c:Category) RETURN c.name, id(c)").data;
      const products = exec("MATCH (p:Product) RETURN p.name, id(p)").data;

      const catIds: Record<string, string> = {};
      const prodIds: Record<string, string> = {};

      for (const row of categories) {
        catIds[row["c.name"] as string] = row.id as string;
      }
      for (const row of products) {
        prodIds[row["p.name"] as string] = row.id as string;
      }

      db.insertEdge("pc1", "IN_CATEGORY", prodIds["Laptop"], catIds["Electronics"]);
      db.insertEdge("pc2", "IN_CATEGORY", prodIds["Headphones"], catIds["Electronics"]);
      db.insertEdge("pc3", "IN_CATEGORY", prodIds["TypeScript Handbook"], catIds["Books"]);
      db.insertEdge("pc4", "IN_CATEGORY", prodIds["T-Shirt"], catIds["Clothing"]);

      // Query products in Electronics category (filters by target node property)
      const electronics = exec(`
        MATCH (p:Product)-[:IN_CATEGORY]->(c:Category {name: 'Electronics'})
        RETURN p.name, p.price
      `);
      expect(electronics.data).toHaveLength(2);

      // Find expensive products (price > 100)
      const expensive = exec("MATCH (p:Product) WHERE p.price > 100 RETURN p.name, p.price");
      expect(expensive.data).toHaveLength(2);

      // Find products with low stock
      const lowStock = exec("MATCH (p:Product) WHERE p.stock < 100 RETURN p.name, p.stock");
      expect(lowStock.data).toHaveLength(1);
      expect(lowStock.data[0]["p.name"]).toBe("Laptop");
    });

    it("tracks order history", () => {
      exec("CREATE (c:Customer {name: 'Jane', customerId: 'CUST-001'})");
      exec("CREATE (p:Product {name: 'Widget', price: 19.99, sku: 'WID-001'})");

      // Create orders
      exec("CREATE (o:Order {orderId: 'ORD-001', status: 'delivered', total: 59.97, createdAt: '2024-01-10'})");
      exec("CREATE (o:Order {orderId: 'ORD-002', status: 'shipped', total: 19.99, createdAt: '2024-01-15'})");
      exec("CREATE (o:Order {orderId: 'ORD-003', status: 'pending', total: 39.98, createdAt: '2024-01-20'})");

      // Link orders to customer
      const customer = exec("MATCH (c:Customer {customerId: 'CUST-001'}) RETURN id(c)").data[0];
      const orders = exec("MATCH (o:Order) RETURN o.orderId, id(o)").data;

      for (const order of orders) {
        db.insertEdge(
          `placed-${order["o.orderId"]}`,
          "PLACED",
          customer.id as string,
          order.id as string
        );
      }

      // Count customer's orders
      const orderCount = exec(`
        MATCH (c:Customer {customerId: 'CUST-001'})-[:PLACED]->(o:Order)
        RETURN COUNT(o)
      `);
      expect(orderCount.data[0].count).toBe(3);

      // Find pending orders
      const pending = exec(`
        MATCH (c:Customer)-[:PLACED]->(o:Order)
        WHERE o.status = 'pending'
        RETURN o.orderId, o.total
      `);
      expect(pending.data).toHaveLength(1);
      expect(pending.data[0]["o.orderId"]).toBe("ORD-003");
    });
  });

  describe("Knowledge Graph", () => {
    it("models entities and relationships for a wiki-like system", () => {
      // Create entities
      exec("CREATE (e:Entity {name: 'Albert Einstein', type: 'Person', born: 1879, died: 1955})");
      exec("CREATE (e:Entity {name: 'Theory of Relativity', type: 'Theory', year: 1905})");
      exec("CREATE (e:Entity {name: 'Germany', type: 'Country'})");
      exec("CREATE (e:Entity {name: 'Switzerland', type: 'Country'})");
      exec("CREATE (e:Entity {name: 'Princeton University', type: 'Institution'})");
      exec("CREATE (e:Entity {name: 'Nobel Prize in Physics', type: 'Award', year: 1921})");

      const entities = exec("MATCH (e:Entity) RETURN e.name, id(e)").data;
      const entityIds: Record<string, string> = {};
      for (const row of entities) {
        entityIds[row["e.name"] as string] = row.id as string;
      }

      // Create relationships
      db.insertEdge("r1", "DEVELOPED", entityIds["Albert Einstein"], entityIds["Theory of Relativity"]);
      db.insertEdge("r2", "BORN_IN", entityIds["Albert Einstein"], entityIds["Germany"]);
      db.insertEdge("r3", "WORKED_AT", entityIds["Albert Einstein"], entityIds["Princeton University"]);
      db.insertEdge("r4", "RECEIVED", entityIds["Albert Einstein"], entityIds["Nobel Prize in Physics"]);
      db.insertEdge("r5", "LIVED_IN", entityIds["Albert Einstein"], entityIds["Switzerland"], { years: "1895-1914" });

      // Query: What did Einstein develop?
      const developed = exec(`
        MATCH (e:Entity {name: 'Albert Einstein'})-[:DEVELOPED]->(t:Entity)
        RETURN t.name, t.type
      `);
      expect(developed.data[0]["t.name"]).toBe("Theory of Relativity");

      // Query: Find all people (by type)
      const people = exec("MATCH (e:Entity) WHERE e.type = 'Person' RETURN e.name");
      expect(people.data).toHaveLength(1);

      // Query: Count relationships from Einstein
      const relCount = exec(`
        MATCH (e:Entity {name: 'Albert Einstein'})-[r]->(target:Entity)
        RETURN COUNT(r)
      `);
      expect(relCount.data[0].count).toBe(5);
    });
  });

  describe("Task Management", () => {
    it("models projects, tasks, and assignments", () => {
      // Create project
      exec("CREATE (p:Project {name: 'Website Redesign', status: 'active', deadline: '2024-06-01'})");

      // Create team members
      exec("CREATE (u:TeamMember {name: 'Alice', role: 'designer'})");
      exec("CREATE (u:TeamMember {name: 'Bob', role: 'developer'})");
      exec("CREATE (u:TeamMember {name: 'Charlie', role: 'developer'})");

      // Create tasks
      exec("CREATE (t:Task {title: 'Design mockups', status: 'completed', priority: 'high'})");
      exec("CREATE (t:Task {title: 'Implement frontend', status: 'in_progress', priority: 'high'})");
      exec("CREATE (t:Task {title: 'Setup CI/CD', status: 'pending', priority: 'medium'})");
      exec("CREATE (t:Task {title: 'Write tests', status: 'pending', priority: 'medium'})");
      exec("CREATE (t:Task {title: 'Documentation', status: 'pending', priority: 'low'})");

      // Get IDs
      const project = exec("MATCH (p:Project) RETURN id(p)").data[0];
      const members = exec("MATCH (m:TeamMember) RETURN m.name, id(m)").data;
      const tasks = exec("MATCH (t:Task) RETURN t.title, id(t)").data;

      const memberIds: Record<string, string> = {};
      const taskIds: Record<string, string> = {};

      for (const row of members) {
        memberIds[row["m.name"] as string] = row.id as string;
      }
      for (const row of tasks) {
        taskIds[row["t.title"] as string] = row.id as string;
      }

      // Link tasks to project
      for (const taskId of Object.values(taskIds)) {
        db.insertEdge(`pt-${taskId}`, "BELONGS_TO", taskId, project.id as string);
      }

      // Assign tasks to members
      db.insertEdge("a1", "ASSIGNED_TO", taskIds["Design mockups"], memberIds["Alice"]);
      db.insertEdge("a2", "ASSIGNED_TO", taskIds["Implement frontend"], memberIds["Bob"]);
      db.insertEdge("a3", "ASSIGNED_TO", taskIds["Setup CI/CD"], memberIds["Charlie"]);
      db.insertEdge("a4", "ASSIGNED_TO", taskIds["Write tests"], memberIds["Bob"]);
      db.insertEdge("a5", "ASSIGNED_TO", taskIds["Write tests"], memberIds["Charlie"]);

      // Find Bob's tasks (filters by target node property)
      const bobTasks = exec(`
        MATCH (t:Task)-[:ASSIGNED_TO]->(m:TeamMember {name: 'Bob'})
        RETURN t.title, t.status
      `);
      expect(bobTasks.data).toHaveLength(2);

      // Find high priority tasks
      const highPriority = exec("MATCH (t:Task) WHERE t.priority = 'high' RETURN t.title");
      expect(highPriority.data).toHaveLength(2);

      // Count pending tasks
      const pendingCount = exec("MATCH (t:Task) WHERE t.status = 'pending' RETURN COUNT(t)");
      expect(pendingCount.data[0].count).toBe(3);

      // Find unassigned tasks (tasks with no ASSIGNED_TO edge)
      // This would require a more complex query pattern we haven't implemented
    });
  });

  describe("Content Management", () => {
    it("models articles, tags, and authors", () => {
      // Create authors
      exec("CREATE (a:Author {name: 'Jane Writer', bio: 'Tech blogger', verified: true})");
      exec("CREATE (a:Author {name: 'John Coder', bio: 'Developer advocate', verified: true})");

      // Create tags
      exec("CREATE (t:Tag {name: 'javascript', slug: 'javascript', postCount: 0})");
      exec("CREATE (t:Tag {name: 'typescript', slug: 'typescript', postCount: 0})");
      exec("CREATE (t:Tag {name: 'tutorial', slug: 'tutorial', postCount: 0})");

      // Create articles
      exec(`CREATE (a:Article {
        title: 'Getting Started with TypeScript',
        slug: 'getting-started-typescript',
        status: 'published',
        views: 1500,
        publishedAt: '2024-01-10'
      })`);
      exec(`CREATE (a:Article {
        title: 'Advanced JavaScript Patterns',
        slug: 'advanced-js-patterns',
        status: 'published',
        views: 2300,
        publishedAt: '2024-01-05'
      })`);
      exec(`CREATE (a:Article {
        title: 'Draft Article',
        slug: 'draft-article',
        status: 'draft',
        views: 0
      })`);

      // Get IDs
      const authors = exec("MATCH (a:Author) RETURN a.name, id(a)").data;
      const tags = exec("MATCH (t:Tag) RETURN t.name, id(t)").data;
      const articles = exec("MATCH (a:Article) RETURN a.slug, id(a)").data;

      const authorIds: Record<string, string> = {};
      const tagIds: Record<string, string> = {};
      const articleIds: Record<string, string> = {};

      for (const row of authors) authorIds[row["a.name"] as string] = row.id as string;
      for (const row of tags) tagIds[row["t.name"] as string] = row.id as string;
      for (const row of articles) articleIds[row["a.slug"] as string] = row.id as string;

      // Link articles to authors
      db.insertEdge("w1", "WROTE", authorIds["Jane Writer"], articleIds["getting-started-typescript"]);
      db.insertEdge("w2", "WROTE", authorIds["John Coder"], articleIds["advanced-js-patterns"]);
      db.insertEdge("w3", "WROTE", authorIds["Jane Writer"], articleIds["draft-article"]);

      // Link articles to tags
      db.insertEdge("tag1", "TAGGED", articleIds["getting-started-typescript"], tagIds["typescript"]);
      db.insertEdge("tag2", "TAGGED", articleIds["getting-started-typescript"], tagIds["tutorial"]);
      db.insertEdge("tag3", "TAGGED", articleIds["advanced-js-patterns"], tagIds["javascript"]);

      // Find published articles
      const published = exec("MATCH (a:Article) WHERE a.status = 'published' RETURN a.title");
      expect(published.data).toHaveLength(2);

      // Find articles by Jane (filters by source node property)
      const janeArticles = exec(`
        MATCH (author:Author {name: 'Jane Writer'})-[:WROTE]->(article:Article)
        RETURN article.title
      `);
      expect(janeArticles.data).toHaveLength(2);

      // Find popular articles (views > 1000)
      const popular = exec("MATCH (a:Article) WHERE a.views > 1000 RETURN a.title, a.views");
      expect(popular.data).toHaveLength(2);

      // Count articles per status
      const publishedCount = exec("MATCH (a:Article) WHERE a.status = 'published' RETURN COUNT(a)");
      expect(publishedCount.data[0].count).toBe(2);
    });
  });

  describe("Stress Tests", () => {
    it("handles 100 nodes efficiently", () => {
      const startTime = performance.now();

      // Create 100 users
      for (let i = 0; i < 100; i++) {
        exec(`CREATE (u:User {name: 'User ${i}', index: ${i}, email: 'user${i}@test.com'})`);
      }

      const createTime = performance.now() - startTime;

      // Query all users
      const queryStart = performance.now();
      const result = exec("MATCH (u:User) RETURN u.name");
      const queryTime = performance.now() - queryStart;

      expect(result.data).toHaveLength(100);
      expect(createTime).toBeLessThan(5000); // Should complete in under 5 seconds
      expect(queryTime).toBeLessThan(1000); // Query should be fast
    });

    it("handles complex WHERE conditions", () => {
      // Create test data
      for (let i = 0; i < 50; i++) {
        exec(`CREATE (p:Product {
          name: 'Product ${i}',
          price: ${10 + i * 5},
          stock: ${i % 10 * 10},
          category: '${i % 3 === 0 ? "A" : i % 3 === 1 ? "B" : "C"}',
          active: ${i % 2 === 0}
        })`);
      }

      // Complex query
      const result = exec(`
        MATCH (p:Product)
        WHERE p.price > 50 AND p.price < 200 AND p.stock > 30
        RETURN p.name, p.price, p.stock
        LIMIT 10
      `);

      expect(result.data.length).toBeLessThanOrEqual(10);
      for (const row of result.data) {
        expect(row["p.price"]).toBeGreaterThan(50);
        expect(row["p.price"]).toBeLessThan(200);
        expect(row["p.stock"]).toBeGreaterThan(30);
      }
    });

    it("handles string operations efficiently", () => {
      // Create products with various names
      exec("CREATE (p:Product {name: 'Apple iPhone 15', sku: 'APL-001'})");
      exec("CREATE (p:Product {name: 'Apple MacBook Pro', sku: 'APL-002'})");
      exec("CREATE (p:Product {name: 'Samsung Galaxy S24', sku: 'SAM-001'})");
      exec("CREATE (p:Product {name: 'Google Pixel 8', sku: 'GOO-001'})");
      exec("CREATE (p:Product {name: 'Microsoft Surface', sku: 'MIC-001'})");

      // CONTAINS
      const appleProducts = exec("MATCH (p:Product) WHERE p.name CONTAINS 'Apple' RETURN p.name");
      expect(appleProducts.data).toHaveLength(2);

      // STARTS WITH
      const samsungProducts = exec("MATCH (p:Product) WHERE p.name STARTS WITH 'Samsung' RETURN p.name");
      expect(samsungProducts.data).toHaveLength(1);

      // ENDS WITH
      const proProducts = exec("MATCH (p:Product) WHERE p.name ENDS WITH 'Pro' RETURN p.name");
      expect(proProducts.data).toHaveLength(1);
    });
  });

  describe("Conrad", () => {
    it('should be nice to me', () => {
      const name = "Conrad"
      exec(
        // language=Cypher
        `
          CREATE(a:Man{name:$name})-[:IS_MARRIED_TO]->(b:Woman{name:"Maëva"})
        `,
        {name}
      )

      const conrad =  exec("MATCH (a:Man) RETURN a.name as name");

      expect(conrad.data[0].name).toEqual(name)

    })
  })

  describe("Edge Cases", () => {
    it("handles empty results gracefully", () => {
      const result = exec("MATCH (n:NonExistentLabel) RETURN n");
      expect(result.data).toHaveLength(0);
      expect(result.meta.count).toBe(0);
    });

    it("handles unicode in properties", () => {
      exec("CREATE (u:User {name: '日本語', emoji: '🎉', arabic: 'مرحبا'})");

      const result = exec("MATCH (u:User) RETURN u.name, u.emoji, u.arabic");
      expect(result.data[0]["u.name"]).toBe("日本語");
      expect(result.data[0]["u.emoji"]).toBe("🎉");
      expect(result.data[0]["u.arabic"]).toBe("مرحبا");
    });

    it("handles special characters in strings", () => {
      exec(`CREATE (n:Note {content: 'Line 1\\nLine 2\\tTabbed'})`);
      exec(`CREATE (n:Note {content: 'Quote: "Hello"'})`);
      exec(`CREATE (n:Note {content: "Single quote: 'test'"})`);

      const result = exec("MATCH (n:Note) RETURN n.content");
      expect(result.data).toHaveLength(3);
    });

    it("handles null values correctly", () => {
      exec("CREATE (u:User {name: 'Test', middleName: null, age: 25})");

      const result = exec("MATCH (u:User) RETURN u.name, u.middleName, u.age");
      expect(result.data[0]["u.name"]).toBe("Test");
      expect(result.data[0]["u.middleName"]).toBeNull();
      expect(result.data[0]["u.age"]).toBe(25);
    });

    it("handles boolean values correctly", () => {
      exec("CREATE (u:User {name: 'Active', isActive: true, isAdmin: false})");

      const result = exec("MATCH (u:User) RETURN u.isActive, u.isAdmin");
      // Booleans are now properly returned as true/false (not 1/0)
      expect(result.data[0]["u.isActive"]).toBe(true);
      expect(result.data[0]["u.isAdmin"]).toBe(false);
    });

    it("handles arrays in properties", () => {
      exec("CREATE (u:User {name: 'Tagged', tags: ['admin', 'user', 'verified']})");

      const result = exec("MATCH (u:User) RETURN u.tags");
      expect(result.data[0]["u.tags"]).toEqual(["admin", "user", "verified"]);
    });

    it("handles very long property values", () => {
      const longString = "x".repeat(10000);
      exec(`CREATE (n:Note {content: '${longString}'})`);

      const result = exec("MATCH (n:Note) RETURN n.content");
      expect(result.data[0]["n.content"]).toHaveLength(10000);
    });

    it("handles numeric edge cases", () => {
      exec("CREATE (n:Number {int: 0, negative: -42, float: 3.14159, large: 9999999999})");

      const result = exec("MATCH (n:Number) RETURN n.int, n.negative, n.float, n.large");

      expect(result.data[0]["n.int"]).toBe(0);
      expect(result.data[0]["n.negative"]).toBe(-42);
      expect(result.data[0]["n.float"]).toBeCloseTo(3.14159);
      expect(result.data[0]["n.large"]).toBe(9999999999);
    });
  });
});
