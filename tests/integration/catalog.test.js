import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { prisma } from '../../src/lib/prisma.js';
import { app } from '../../src/app.js';
import { importCatalog, mapEdition, saveMetadata } from '../../scripts/catalog.js';

test('PostgreSQL: catalog reimport preserves user data and works with existing API', {skip:!process.env.TEST_DATABASE_URL,timeout:60000}, async t => {
  const manifest=JSON.parse(readFileSync(new URL('../../scripts/catalog.json',import.meta.url)));
  // Refuse to claim or clean up any pre-existing catalog records.
  assert.equal(await prisma.book.count({where:{isbn:{in:manifest.map(e=>e.isbn)}}}),0,'Test requires these ISBNs to be absent; do not delete existing records');
  const books=[], users=[], genreIds=[];
  const priorGenres=new Set((await prisma.genre.findMany()).map(g=>g.id));
  t.after(async()=>{
    await prisma.book.deleteMany({where:{id:{in:books}}});
    await prisma.user.deleteMany({where:{id:{in:users}}});
    await prisma.genre.deleteMany({where:{id:{in:genreIds},bookGenres:{none:{}}}});
    await prisma.$disconnect();
  });
  // Metadata fixtures are explicitly mocked, not live-resolved catalog claims.
  const resolve=async isbn=>mapEdition(isbn,{isbn_13:[isbn],title:manifest.find(e=>e.isbn===isbn).label,publish_date:'2003',subjects:['Fiction'],covers:[123]},['Fixture Author']);
  const save=async data=>{
    let result;
    try { result=await saveMetadata(prisma,data,true); }
    catch (error) { throw new Error(`save ${data.isbn}: ${error.code ?? error.message}`); }
    const row=await prisma.book.findUnique({where:{isbn:data.isbn},include:{bookGenres:true}});
    if(!books.includes(row.id)) books.push(row.id);
    for(const link of row.bookGenres) if(!priorGenres.has(link.genreId)) genreIds.push(link.genreId);
    return result;
  };
  const dry=await importCatalog(manifest,{resolve,save:data=>saveMetadata(prisma,data,false)});
  assert.equal(dry.created,30); assert.equal(await prisma.book.count({where:{isbn:{in:manifest.map(e=>e.isbn)}}}),0);
  const importMessages=[];
  const firstImport=await importCatalog(manifest,{resolve,save,report:message=>importMessages.push(message)});
  assert.deepEqual(importMessages,[]);
  assert.equal(firstImport.created,30);
  const tag=randomUUID().slice(0,8);
  const auth=await request(app).post('/api/auth/signup').set('X-Bookish-CSRF','1').send({username:`catalog_${tag}`,email:`catalog_${tag}@example.com`,password:'catalog fixture password'}).expect(201);
  users.push(auth.body.user.id); const token=auth.body.accessToken, bookId=books[0];
  const post=(url,body)=>request(app).post(`/api/${url}`).auth(token,{type:'bearer'}).send(body);
  await post('user-books',{bookId,status:'read',userRating:5}).expect(200);
  const review=await post('reviews',{bookId,rating:4,reviewText:'Preserve my review'}).expect(200);
  await request(app).put(`/api/reviews/${review.body.data.id}/like`).auth(token,{type:'bearer'}).expect(200);
  const snapshot=async()=>({book:await prisma.book.findUnique({where:{id:bookId}}),review:await prisma.review.findUnique({where:{id:review.body.data.id}}),shelves:await prisma.userBook.findMany({where:{userId:users[0]}}),likes:await prisma.reviewLike.findMany({where:{userId:users[0]}}),user:await prisma.user.findUnique({where:{id:users[0]}}),sessions:await prisma.refreshSession.findMany({where:{userId:users[0]}})});
  const before=await snapshot();
  assert.equal((await importCatalog(manifest,{resolve,save})).unchanged,30);
  assert.deepEqual(await snapshot(),before);
  const changed={...await resolve(manifest[0].isbn),title:'Updated catalog title'};
  assert.equal(await save(changed),'updated');
  const after=await snapshot(); assert.equal(Number(after.book.averageRating),4); assert.equal(after.book.ratingsCount,1);
  for(const key of ['review','shelves','likes','user','sessions']) assert.deepEqual(after[key],before[key]);
  const discovery=await request(app).get('/api/books?q=Updated%20catalog&genre=fiction&sort=publicationYear&limit=1').expect(200);
  assert.equal(discovery.body.data[0].id,bookId);
  const detail=await request(app).get(`/api/books/${bookId}`).auth(token,{type:'bearer'}).expect(200);
  assert.equal(detail.body.data.reviews.data[0].likedByMe,true);
  assert.equal(detail.body.data.averageRating,4);
  await request(app).get('/api/user-books?status=read').auth(token,{type:'bearer'}).expect(200);
  assert.equal(await prisma.book.count({where:{isbn:{in:manifest.map(e=>e.isbn)}}}),30);
});
